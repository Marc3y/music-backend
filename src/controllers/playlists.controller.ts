import { Response } from "express";
import { ObjectId } from "mongodb";
import { randomBytes } from "crypto";
import { getDB } from "../config/db";
import { Playlist } from "../models/Playlist";
import { SavedShare } from "../models/SavedShare";
import { AuthRequest } from "../middleware/auth.middleware";
import {
  createPlaylistSchema,
  updatePlaylistSchema,
  uploadUrlRequestSchema,
  updatePlaylistShareSchema,
  updateCollaboratorsSchema,
} from "../utils/validators";
import {
  generateObjectKey,
  getUploadUrl,
  getDownloadUrl,
  getDownloadUrlAttachment,
  deleteObject,
} from "../services/storage.service";
import { AudioFile } from "../models/AudioFile";
import { User } from "../models/User";
import { findSelectedVersion } from "../utils/trackVersions";
import {
  getEditablePlaylist,
  isOwner,
  canViewShared,
} from "../utils/playlistAccess";

/** username + kurzlebige Avatar-URL für die Anzeige auf der Playlist-Seite */
async function serializeUserBrief(u: Pick<User, "username" | "avatarKey">) {
  return {
    username: u.username,
    avatarUrl: u.avatarKey ? await getDownloadUrl(u.avatarKey) : null,
  };
}


export async function createPlaylist(req: AuthRequest, res: Response) {
  const parseResult = createPlaylistSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({ error: parseResult.error.issues[0].message });
  }

  const db = getDB();
  const playlists = db.collection<Playlist>("playlists");

  const newPlaylist: Playlist = {
    name: parseResult.data.name,
    owner: new ObjectId(req.userId),
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const result = await playlists.insertOne(newPlaylist);
  res.status(201).json({ ...newPlaylist, _id: result.insertedId });
}

export async function getPlaylists(req: AuthRequest, res: Response) {
  const db = getDB();
  const playlists = db.collection<Playlist>("playlists");

  const userPlaylists = await playlists
    .find({ owner: new ObjectId(req.userId) })
    .sort({ createdAt: -1 })
    .toArray();

  // Für jede Playlist eine kurzlebige Cover-URL generieren, falls vorhanden
  const withCoverUrls = await Promise.all(
    userPlaylists.map(async (playlist) => ({
      ...playlist,
      coverUrl: playlist.coverKey ? await getDownloadUrl(playlist.coverKey) : null,
    }))
  );

  res.json(withCoverUrls);
}

export async function getPlaylistById(req: AuthRequest, res: Response) {

  const { id } = req.params;
  if (typeof id !== "string" || !ObjectId.isValid(id)) {
    return res.status(400).json({ error: "Ungültige Playlist-ID" });
  }

  const playlist = await getEditablePlaylist(id, req.userId!);
  if (!playlist) {
    return res.status(404).json({ error: "Playlist nicht gefunden" });
  }

  const coverUrl = playlist.coverKey ? await getDownloadUrl(playlist.coverKey) : null;
  const role = isOwner(playlist, req.userId) ? "owner" : "collaborator";

  // Owner + aktive (beigetretene) Mitglieder für die Anzeige auflösen
  const users = getDB().collection<User>("users");
  const joinedIds = (playlist.collaborators ?? [])
    .map((c) => c.userId)
    .filter((id): id is ObjectId => !!id);
  const ids = [playlist.owner, ...joinedIds];
  const userDocs = await users
    .find({ _id: { $in: ids } }, { projection: { username: 1, avatarKey: 1 } })
    .toArray();
  const byId = new Map(userDocs.map((u) => [u._id!.toString(), u]));

  const ownerDoc = byId.get(playlist.owner.toString());
  const ownerUser = ownerDoc ? await serializeUserBrief(ownerDoc) : null;
  const activeCollaborators = await Promise.all(
    joinedIds
      .map((id) => byId.get(id.toString()))
      .filter((u): u is (typeof userDocs)[number] => !!u)
      .map(serializeUserBrief)
  );

  res.json({ ...playlist, coverUrl, role, ownerUser, activeCollaborators });
}

export async function updatePlaylist(req: AuthRequest, res: Response) {
  const parseResult = updatePlaylistSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({ error: parseResult.error.issues[0].message });
  }

  const { id } = req.params;
  if (typeof id !== "string" || !ObjectId.isValid(id)) {
    return res.status(400).json({ error: "Ungültige Playlist-ID" });
  }

  const editable = await getEditablePlaylist(id, req.userId!);
  if (!editable) {
    return res.status(404).json({ error: "Playlist nicht gefunden" });
  }

  const playlists = getDB().collection<Playlist>("playlists");
  const result = await playlists.findOneAndUpdate(
    { _id: editable._id },
    { $set: { ...parseResult.data, updatedAt: new Date() } },
    { returnDocument: "after" }
  );

  res.json(result);
}

export async function deletePlaylist(req: AuthRequest, res: Response) {

    const { id } = req.params;
    if (typeof id !== "string" || !ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Ungültige Playlist-ID" });
    }

    const db = getDB();
    const playlists = db.collection<Playlist>("playlists");
    const audioFiles = db.collection<AudioFile>("audioFiles");

    // Löschen nur durch den Owner
    const playlist = await playlists.findOne({
      _id: new ObjectId(id),
      owner: new ObjectId(req.userId),
    });

    if (!playlist) {
      return res.status(404).json({ error: "Playlist nicht gefunden" });
    }
  
    // Alle Tracks dieser Playlist finden und deren MinIO-Objekte löschen
    const tracksInPlaylist = await audioFiles.find({ playlistId: playlist._id }).toArray();

    for (const track of tracksInPlaylist) {
      for (const v of track.versions ?? []) {
        if (v.key) {
          try { await deleteObject(v.key); } catch { /* ignore */ }
        }
        if (v.projectKey) {
          try { await deleteObject(v.projectKey); } catch { /* ignore */ }
        }
      }
      if (track.coverKey) {
        try { await deleteObject(track.coverKey); } catch { /* ignore */ }
      }
    }
  
    await audioFiles.deleteMany({ playlistId: playlist._id });
  
    if (playlist.coverKey) {
      await deleteObject(playlist.coverKey);
    }

    await playlists.deleteOne({ _id: playlist._id });

    const tokens = [playlist.shareToken, playlist.collabToken].filter(Boolean) as string[];
    if (tokens.length) {
      await db.collection<SavedShare>("savedShares").deleteMany({ token: { $in: tokens } });
    }

    res.json({ message: "Playlist und alle enthaltenen Tracks gelöscht" });
  }

// Presigned URL für Cover-Upload anfordern
export async function getPlaylistCoverUploadUrl(req: AuthRequest, res: Response) {
  const parseResult = uploadUrlRequestSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({ error: parseResult.error.issues[0].message });
  }

  const { id } = req.params;
  if (typeof id !== "string" || !ObjectId.isValid(id)) {
    return res.status(400).json({ error: "Ungültige Playlist-ID" });
  }

  const playlist = await getEditablePlaylist(id, req.userId!);
  if (!playlist) {
    return res.status(404).json({ error: "Playlist nicht gefunden" });
  }

  const { filename, contentType } = parseResult.data;

  if (!contentType.startsWith("image/")) {
    return res.status(400).json({ error: "Nur Bilddateien erlaubt" });
  }

  const key = generateObjectKey(`covers/${req.userId}`, filename);
  const uploadUrl = await getUploadUrl(key, contentType);

  // Key schon jetzt speichern, damit wir wissen wohin es hochgeladen wird
  await getDB()
    .collection<Playlist>("playlists")
    .updateOne({ _id: playlist._id }, { $set: { coverKey: key, updatedAt: new Date() } });

  res.json({ uploadUrl, key });
}

/* ==================== Playlist teilen / Collaboration ==================== */

async function ownedPlaylist(id: unknown, userId: string) {
  if (typeof id !== "string" || !ObjectId.isValid(id)) return null;
  return getDB()
    .collection<Playlist>("playlists")
    .findOne({ _id: new ObjectId(id), owner: new ObjectId(userId) });
}

function collabView(pl: Playlist) {
  return (pl.collaborators ?? []).map((c) => ({ username: c.username, joined: !!c.userId }));
}

// PATCH /playlists/:id/share  (owner-only)
export async function updatePlaylistShare(req: AuthRequest, res: Response) {
  const parsed = updatePlaylistShareSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  const playlist = await ownedPlaylist(req.params.id, req.userId!);
  if (!playlist) return res.status(404).json({ error: "Playlist nicht gefunden" });

  const playlists = getDB().collection<Playlist>("playlists");
  const savedShares = getDB().collection<SavedShare>("savedShares");
  const d = parsed.data;

  const set: Partial<Playlist> = { updatedAt: new Date() };
  if (d.shareEnabled !== undefined) {
    set.shareEnabled = d.shareEnabled;
    if (d.shareEnabled && !playlist.shareToken) {
      set.shareToken = randomBytes(24).toString("hex");
    }
  }
  if (d.shareRestricted !== undefined) set.shareRestricted = d.shareRestricted;
  if (d.shareAllowDownload !== undefined) set.shareAllowDownload = d.shareAllowDownload;
  if (d.allowedUsernames !== undefined) {
    set.allowedUsernames = [...new Set(d.allowedUsernames.map((u) => u.toLowerCase()))];
  }

  await playlists.updateOne({ _id: playlist._id }, { $set: set });
  const updated = await playlists.findOne({ _id: playlist._id });

  const token = updated?.shareToken;
  if (token) {
    // Teilen deaktiviert -> alle gespeicherten Einträge weg
    if (d.shareEnabled === false) {
      await savedShares.deleteMany({ type: "playlist", token });
    } else if (updated?.shareRestricted) {
      // Nicht mehr erlaubte Nutzer entfernen
      const allowed = updated.allowedUsernames ?? [];
      const kept = await savedShares.find({ type: "playlist", token }).toArray();
      for (const s of kept) {
        const uname = (await getDB()
          .collection("users")
          .findOne({ _id: s.userId }, { projection: { username: 1 } })) as { username?: string } | null;
        if (uname?.username && !allowed.includes(uname.username.toLowerCase())) {
          await savedShares.deleteOne({ _id: s._id });
        }
      }
    }
  }

  const coverUrl = updated?.coverKey ? await getDownloadUrl(updated.coverKey) : null;
  res.json({ ...updated, coverUrl, role: "owner" });
}

// PATCH /playlists/:id/collaborators  (owner-only)
export async function updateCollaborators(req: AuthRequest, res: Response) {
  const parsed = updateCollaboratorsSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  const playlist = await ownedPlaylist(req.params.id, req.userId!);
  if (!playlist) return res.status(404).json({ error: "Playlist nicht gefunden" });

  const wanted = [...new Set(parsed.data.usernames.map((u) => u.toLowerCase()))].filter(
    (u) => u !== undefined
  );
  const existing = playlist.collaborators ?? [];
  const byName = new Map(existing.map((c) => [c.username, c]));

  const next = wanted.map(
    (username) => byName.get(username) ?? { username }
  );
  const removed = existing.filter((c) => !wanted.includes(c.username));

  const collabToken =
    playlist.collabToken ?? (next.length ? randomBytes(24).toString("hex") : undefined);

  const playlists = getDB().collection<Playlist>("playlists");
  await playlists.updateOne(
    { _id: playlist._id },
    { $set: { collaborators: next, collabToken, updatedAt: new Date() } }
  );

  // Entfernte Mitglieder aus deren Mediathek werfen
  const removedIds = removed.map((c) => c.userId).filter(Boolean) as ObjectId[];
  if (removedIds.length && playlist.collabToken) {
    await getDB()
      .collection<SavedShare>("savedShares")
      .deleteMany({ type: "collab", token: playlist.collabToken, userId: { $in: removedIds } });
  }

  res.json({ collabToken: collabToken ?? null, collaborators: collabView({ ...playlist, collaborators: next }) });
}

// POST /playlists/join/:token  (requireAuth)
export async function joinPlaylist(req: AuthRequest, res: Response) {
  const token = typeof req.params.token === "string" ? req.params.token : null;
  if (!token) return res.status(400).json({ error: "Ungültiger Link" });

  const playlists = getDB().collection<Playlist>("playlists");
  const playlist = await playlists.findOne({ collabToken: token });
  if (!playlist) {
    return res.status(404).json({ error: "Einladung ungültig oder zurückgezogen" });
  }

  const uname = (await getDB()
    .collection("users")
    .findOne({ _id: new ObjectId(req.userId) }, { projection: { username: 1 } })) as {
    username?: string;
  } | null;
  const unameLower = uname?.username?.toLowerCase();

  const entry = (playlist.collaborators ?? []).find((c) => c.username === unameLower);
  if (!entry) {
    return res.status(403).json({ error: "Du bist nicht als Mitglied dieser Playlist eingetragen" });
  }

  if (!entry.userId) {
    await playlists.updateOne(
      { _id: playlist._id, "collaborators.username": unameLower },
      { $set: { "collaborators.$.userId": new ObjectId(req.userId) } }
    );
  }

  await getDB()
    .collection<SavedShare>("savedShares")
    .updateOne(
      { userId: new ObjectId(req.userId), type: "collab", token },
      { $setOnInsert: { userId: new ObjectId(req.userId), type: "collab", token, createdAt: new Date() } },
      { upsert: true }
    );

  res.json({ playlistId: playlist._id!.toString(), name: playlist.name });
}

/* ==================== Öffentliche Playlist-Ansicht ==================== */

async function loadSharedPlaylist(
  req: AuthRequest,
  res: Response
): Promise<{ playlist: Playlist; canDownload: boolean } | null> {
  const token = typeof req.params.token === "string" ? req.params.token : null;
  if (!token) {
    res.status(400).json({ error: "Ungültiger Link" });
    return null;
  }
  const playlist = await getDB()
    .collection<Playlist>("playlists")
    .findOne({ shareToken: token });
  if (!playlist || !playlist.shareEnabled) {
    res.status(404).json({ error: "Playlist nicht gefunden oder nicht geteilt" });
    return null;
  }
  const access = await canViewShared(playlist, req.userId);
  if (!access.ok) {
    res.status(403).json({
      error: access.needsLogin
        ? "Bitte einloggen, um auf diese Playlist zuzugreifen"
        : "Kein Zugriff auf diese Playlist",
      needsLogin: !!access.needsLogin,
      name: playlist.name,
    });
    return null;
  }
  return { playlist, canDownload: !!playlist.shareAllowDownload };
}

export async function getSharedPlaylist(req: AuthRequest, res: Response) {
  const ctx = await loadSharedPlaylist(req, res);
  if (!ctx) return;
  const { playlist, canDownload } = ctx;

  const audioFiles = getDB().collection<AudioFile>("audioFiles");
  const tracks = await audioFiles
    .find({ playlistId: playlist._id })
    .sort({ order: 1, createdAt: -1 })
    .toArray();

  res.json({
    accessible: true,
    name: playlist.name,
    coverUrl: playlist.coverKey ? await getDownloadUrl(playlist.coverKey) : null,
    trackCount: tracks.length,
    canDownload,
    tracks: tracks.map((t) => {
      const v = findSelectedVersion(t);
      return {
        _id: t._id!.toString(),
        title: t.title,
        artist: t.artist,
        bpm: v?.bpm ?? t.bpm ?? null,
        musicalKey: v?.musicalKey ?? t.musicalKey ?? null,
        duration: v?.duration ?? t.duration ?? null,
        kind: t.kind ?? "track",
        hasProject: !!v?.projectKey,
      };
    }),
  });
}

async function loadSharedTrack(req: AuthRequest, res: Response) {
  const ctx = await loadSharedPlaylist(req, res);
  if (!ctx) return null;
  const trackId = typeof req.params.trackId === "string" ? req.params.trackId : null;
  if (!trackId || !ObjectId.isValid(trackId)) {
    res.status(400).json({ error: "Ungültige Track-ID" });
    return null;
  }
  const track = await getDB()
    .collection<AudioFile>("audioFiles")
    .findOne({ _id: new ObjectId(trackId), playlistId: ctx.playlist._id });
  if (!track) {
    res.status(404).json({ error: "Track nicht in dieser Playlist" });
    return null;
  }
  return { ...ctx, track, version: findSelectedVersion(track) };
}

export async function getSharedPlaylistStream(req: AuthRequest, res: Response) {
  const ctx = await loadSharedTrack(req, res);
  if (!ctx) return;
  const key = ctx.version?.key ?? ctx.track.key;
  if (!key) return res.status(404).json({ error: "Kein Audio für diesen Eintrag" });
  res.json({ streamUrl: await getDownloadUrl(key) });
}

export async function getSharedPlaylistProject(req: AuthRequest, res: Response) {
  const ctx = await loadSharedTrack(req, res);
  if (!ctx) return;
  if (!ctx.canDownload) {
    return res.status(403).json({ error: "Downloads für diese Playlist nicht erlaubt" });
  }
  const key = ctx.version?.projectKey;
  if (!key) return res.status(404).json({ error: "Keine Projektdatei" });
  const filename = ctx.version?.projectFilename ?? "projekt.zip";
  res.json({ url: await getDownloadUrlAttachment(key, filename), filename });
}