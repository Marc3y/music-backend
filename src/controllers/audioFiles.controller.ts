import { processAudioMetadata } from "../services/metadata.service";
import { Response } from "express";
import { ObjectId } from "mongodb";
import { randomBytes } from "crypto";
import bcrypt from "bcrypt";
import { getDB } from "../config/db";
import { AudioFile } from "../models/AudioFile";
import { Playlist } from "../models/Playlist";
import { AuthRequest } from "../middleware/auth.middleware";
import {
  initAudioUploadSchema,
  confirmAudioUploadSchema,
  updateAudioFileSchema,
  uploadUrlRequestSchema,
  initVersionUploadSchema,
  confirmVersionUploadSchema,
  updateVersionSchema,
  initVersionProjectSchema,
  confirmVersionProjectSchema,
  unlockShareSchema,
  setTrackSharePasswordSchema,
} from "../utils/validators";
import { isAllowedAudioType, isAllowedProjectFile } from "../utils/audioValidation";
import { normalizeKey } from "../utils/musicalKey";
import {
  generateObjectKey,
  getUploadUrl,
  getDownloadUrl,
  getDownloadUrlAttachment,
  deleteObject,
} from "../services/storage.service";
import { getStorageUsage, resolveStorageLimit } from "./account.controller";
import { User } from "../models/User";
import { SavedShare } from "../models/SavedShare";
import { getEditablePlaylist } from "../utils/playlistAccess";
import {
  buildVersion,
  buildProjectVersion,
  findSelectedVersion,
  writeMirror,
} from "../utils/trackVersions";
import {
  notifyCollabActivity,
  notifyListen,
} from "../services/notifications.service";
import { logTrackEvent, trackCounts } from "../services/trackStats.service";
import { TrackEvent } from "../models/TrackEvent";
import { hasPlus, type Tier } from "../config/limits";
import {
  generateShareUnlock,
  verifyShareUnlock,
} from "../utils/tokens";

async function requesterHasPlus(userId: string): Promise<boolean> {
  const u = await getDB()
    .collection<User>("users")
    .findOne({ _id: new ObjectId(userId) }, { projection: { tier: 1 } });
  return hasPlus(u?.tier as Tier | undefined);
}

// Playlist zurückgeben, wenn der User sie bearbeiten darf (Owner oder Mitglied)
async function verifyPlaylistOwnership(playlistId: string, userId: string) {
  return getEditablePlaylist(playlistId, userId);
}

// Alle Collaborator einer Playlist über die Aktion eines Users informieren.
async function notifyForTrack(
  track: Pick<AudioFile, "playlistId" | "_id" | "title">,
  actorId: string,
  type:
    | "collab_track_edited"
    | "collab_track_cover"
    | "collab_version_added"
    | "collab_version_removed"
    | "collab_version_selected"
    | "collab_reordered",
  meta?: { field?: string; from?: string | null; to?: string | null }
) {
  const playlist = await getDB()
    .collection<Playlist>("playlists")
    .findOne({ _id: track.playlistId });
  if (!playlist) return;
  await notifyCollabActivity(playlist, actorId, type, {
    trackId: track._id,
    trackTitle: track.title,
    meta,
  });
}

async function safeDelete(key?: string) {
  if (!key) return;
  try {
    await deleteObject(key);
  } catch (err) {
    console.error(`⚠️  Objekt konnte nicht gelöscht werden (${key}):`, err);
  }
}

// Wenn ein Track nicht mehr geteilt wird, verschwindet er auch aus fremden Mediatheken
async function dropSavedShares(...tokens: (string | undefined)[]) {
  const valid = tokens.filter((t): t is string => !!t);
  if (!valid.length) return;
  await getDB()
    .collection<SavedShare>("savedShares")
    .deleteMany({ token: { $in: valid } });
}

// Express 5 typisiert Route-Params als string | string[]
function param(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

// Track zurückgeben, wenn der User die zugehörige Playlist bearbeiten darf
async function verifyTrackOwnership(trackIdRaw: unknown, userId: string) {
  const trackId = param(trackIdRaw);
  if (!trackId || !ObjectId.isValid(trackId)) return null;
  const track = await getDB()
    .collection<AudioFile>("audioFiles")
    .findOne({ _id: new ObjectId(trackId) });
  if (!track) return null;
  const playlist = await getEditablePlaylist(track.playlistId.toString(), userId);
  return playlist ? track : null;
}

// Track mit frischer coverUrl zurückgeben (nach jeder Version-/Projekt-Änderung)
/** Track fürs Frontend aufbereiten: Passwort-Hash raus, `sharePasswordSet` rein. */
function clientTrack<T extends AudioFile>(track: T) {
  const { sharePasswordHash, ...rest } = track;
  return { ...rest, sharePasswordSet: !!sharePasswordHash };
}

async function sendTrack(res: Response, trackId: ObjectId) {
  const db = getDB();
  const track = await db.collection<AudioFile>("audioFiles").findOne({ _id: trackId });
  if (!track) return res.status(404).json({ error: "Track nicht gefunden" });
  const coverUrl = track.coverKey ? await getDownloadUrl(track.coverKey) : null;
  res.json({ ...clientTrack(track), coverUrl });
}

// Storage-Limit-Check für einen weiteren Upload von `additionalBytes`
async function assertWithinLimit(userId: ObjectId, additionalBytes: number) {
  const db = getDB();
  const user = await db.collection<User>("users").findOne({ _id: userId });
  if (!user) return { ok: false as const, status: 404, error: "User nicht gefunden" };
  const used = await getStorageUsage(userId);
  if (used + additionalBytes > resolveStorageLimit(user)) {
    return {
      ok: false as const,
      status: 403,
      error: "Speicherlimit erreicht. Lösche Tracks oder erhöhe dein Limit.",
    };
  }
  return { ok: true as const };
}

// 1. Upload vorbereiten: presigned URL anfordern
export async function initAudioUpload(req: AuthRequest, res: Response) {
  const parseResult = initAudioUploadSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({ error: parseResult.error.issues[0].message });
  }

  const { playlistId } = req.params;
  if (typeof playlistId !== "string" || !ObjectId.isValid(playlistId)) {
    return res.status(400).json({ error: "Ungültige Playlist-ID" });
  }

  const { filename, contentType, fileSize } = parseResult.data;

  if (!isAllowedAudioType(contentType)) {
    return res.status(400).json({ error: "Dateityp nicht erlaubt" });
  }

  const playlist = await verifyPlaylistOwnership(playlistId, req.userId!);
  if (!playlist) {
    return res.status(404).json({ error: "Playlist nicht gefunden" });
  }

  // Speicherlimit prüfen
  const limit = await assertWithinLimit(new ObjectId(req.userId), fileSize);
  if (!limit.ok) return res.status(limit.status).json({ error: limit.error });

  const key = generateObjectKey(`audio/${req.userId}`, filename);
  const uploadUrl = await getUploadUrl(key, contentType);

  res.json({ uploadUrl, key, fileSize, mimeType: contentType });
}

// 2. Upload bestätigen: DB-Eintrag anlegen
export async function confirmAudioUpload(req: AuthRequest, res: Response) {
  const parseResult = confirmAudioUploadSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({ error: parseResult.error.issues[0].message });
  }

  const { playlistId } = req.params;
  if (typeof playlistId !== "string" || !ObjectId.isValid(playlistId)) {
    return res.status(400).json({ error: "Ungültige Playlist-ID" });
  }

  const playlist = await verifyPlaylistOwnership(playlistId, req.userId!);
  if (!playlist) {
    return res.status(404).json({ error: "Playlist nicht gefunden" });
  }

  const { key, originalFilename, fileSize, mimeType } = parseResult.data;
  const db = getDB();
  const audioFiles = db.collection<AudioFile>("audioFiles");

  // Titel aus Dateinamen ableiten (ohne Endung) als Default
  const defaultTitle = originalFilename.replace(/\.[^/.]+$/, "");

  // Default-Artist = Username des Uploaders (eingebettete ID3-Tags überschreiben das später)
  const uploader = await db
    .collection<User>("users")
    .findOne({ _id: new ObjectId(req.userId) }, { projection: { username: 1 } });

  const v0 = buildVersion(key, originalFilename, fileSize, mimeType);

  const newAudioFile: AudioFile = {
    playlistId: playlist._id!,
    owner: new ObjectId(req.userId),
    title: defaultTitle,
    artist: uploader?.username,
    order: Date.now(),
    shareEnabled: false,
    shareProject: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    versions: [v0],
    selectedVersionId: v0._id,
    // Mirror der Hauptversion
    key,
    originalFilename,
    fileSize,
    mimeType,
    bpm: null,
    musicalKey: null,
    status: "processing",
  };

  const result = await audioFiles.insertOne(newAudioFile);
  processAudioMetadata(result.insertedId, v0._id, key);
  void notifyCollabActivity(playlist, req.userId!, "collab_track_added", {
    trackId: result.insertedId,
    trackTitle: defaultTitle,
  });
  res.status(201).json({ ...newAudioFile, _id: result.insertedId });
}

/* ---- Reiner Projekt-Eintrag (nur .zip/.rar, keine Audiodatei) ---- */

export async function initProjectUpload(req: AuthRequest, res: Response) {
  const parsed = initVersionProjectSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  const { playlistId } = req.params;
  if (typeof playlistId !== "string" || !ObjectId.isValid(playlistId)) {
    return res.status(400).json({ error: "Ungültige Playlist-ID" });
  }

  const { filename, contentType, fileSize } = parsed.data;
  if (!isAllowedProjectFile(filename, contentType)) {
    return res.status(400).json({ error: "Nur .zip- oder .rar-Dateien erlaubt" });
  }

  const playlist = await verifyPlaylistOwnership(playlistId, req.userId!);
  if (!playlist) return res.status(404).json({ error: "Playlist nicht gefunden" });

  const limit = await assertWithinLimit(new ObjectId(req.userId), fileSize);
  if (!limit.ok) return res.status(limit.status).json({ error: limit.error });

  const key = generateObjectKey(`projects/${req.userId}`, filename);
  const uploadUrl = await getUploadUrl(key, contentType);
  res.json({ uploadUrl, key });
}

export async function confirmProjectUpload(req: AuthRequest, res: Response) {
  const parsed = confirmVersionProjectSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  const { playlistId } = req.params;
  if (typeof playlistId !== "string" || !ObjectId.isValid(playlistId)) {
    return res.status(400).json({ error: "Ungültige Playlist-ID" });
  }

  const playlist = await verifyPlaylistOwnership(playlistId, req.userId!);
  if (!playlist) return res.status(404).json({ error: "Playlist nicht gefunden" });

  const { key, filename, fileSize } = parsed.data;
  const db = getDB();
  const audioFiles = db.collection<AudioFile>("audioFiles");

  const v0 = buildProjectVersion(key, filename, fileSize);
  const newEntry: AudioFile = {
    playlistId: playlist._id!,
    owner: new ObjectId(req.userId),
    kind: "project",
    title: filename.replace(/\.[^/.]+$/, ""),
    order: Date.now(),
    shareEnabled: false,
    shareProject: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    versions: [v0],
    selectedVersionId: v0._id,
    bpm: null,
    musicalKey: null,
    status: "ready",
  };

  const result = await audioFiles.insertOne(newEntry);
  void notifyCollabActivity(playlist, req.userId!, "collab_track_added", {
    trackId: result.insertedId,
    trackTitle: newEntry.title,
  });
  res.status(201).json({ ...newEntry, _id: result.insertedId });
}

// Alle Tracks einer Playlist auflisten
export async function getAudioFilesByPlaylist(req: AuthRequest, res: Response) {

  const { playlistId } = req.params;
  if (typeof playlistId !== "string" || !ObjectId.isValid(playlistId)) {
    return res.status(400).json({ error: "Ungültige Playlist-ID" });
  }

  const playlist = await verifyPlaylistOwnership(playlistId, req.userId!);
  if (!playlist) {
    return res.status(404).json({ error: "Playlist nicht gefunden" });
  }

  const db = getDB();
  const audioFiles = db.collection<AudioFile>("audioFiles");

  const tracks = await audioFiles
  .find({ playlistId: playlist._id })
  .sort({ order: 1, createdAt: -1 })
  .toArray();

  const withCoverUrls = await Promise.all(
   tracks.map(async (t) => ({
    ...clientTrack(t),
    coverUrl: t.coverKey ? await getDownloadUrl(t.coverKey) : null,
   }))
);

res.json(withCoverUrls);
}

// Einzelnen Track abrufen
export async function getAudioFileById(req: AuthRequest, res: Response) {

  const { id } = req.params;
  if (typeof id !== "string" || !ObjectId.isValid(id)) {
    return res.status(400).json({ error: "Ungültige ID" });
  }

  const db = getDB();
  const audioFiles = db.collection<AudioFile>("audioFiles");

  const track = await verifyTrackOwnership(id, req.userId!);

  if (!track) {
    return res.status(404).json({ error: "Track nicht gefunden" });
  }

  const coverUrl = track.coverKey ? await getDownloadUrl(track.coverKey) : null;
  res.json({ ...clientTrack(track), coverUrl });
}

// Metadaten bearbeiten (Titel, Interpret, Beschreibung)
export async function updateAudioFile(req: AuthRequest, res: Response) {
  const parseResult = updateAudioFileSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({ error: parseResult.error.issues[0].message });
  }

  const { id } = req.params;
  if (typeof id !== "string" || !ObjectId.isValid(id)) {
    return res.status(400).json({ error: "Ungültige ID" });
  }

  const existing = await verifyTrackOwnership(id, req.userId!);
  if (!existing) {
    return res.status(404).json({ error: "Track nicht gefunden" });
  }

  const db = getDB();
  const audioFiles = db.collection<AudioFile>("audioFiles");

  const result = await audioFiles.findOneAndUpdate(
    { _id: existing._id },
    { $set: { ...parseResult.data, updatedAt: new Date() } },
    { returnDocument: "after" }
  );

  if (!result) {
    return res.status(404).json({ error: "Track nicht gefunden" });
  }

  // Eine Detail-Benachrichtigung pro tatsächlich geändertem Feld.
  const d = parseResult.data;
  const changed: Array<[string, string | undefined, string | undefined]> = [];
  if (d.title !== undefined && d.title !== existing.title)
    changed.push(["title", existing.title, d.title]);
  if (d.artist !== undefined && (d.artist || "") !== (existing.artist || ""))
    changed.push(["artist", existing.artist, d.artist]);
  if (
    d.description !== undefined &&
    (d.description || "") !== (existing.description || "")
  )
    changed.push(["description", existing.description, d.description]);
  for (const [field, from, to] of changed) {
    void notifyForTrack(result, req.userId!, "collab_track_edited", {
      field,
      from: from ?? null,
      to: to ?? null,
    });
  }

  const coverUrl = result.coverKey ? await getDownloadUrl(result.coverKey) : null;
  res.json({ ...clientTrack(result), coverUrl });
}

// Eigenes Cover für einen Track hochladen (gleicher Ablauf wie bei Playlist-Cover)
export async function getAudioFileCoverUploadUrl(req: AuthRequest, res: Response) {
  const parseResult = uploadUrlRequestSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({ error: parseResult.error.issues[0].message });
  }

  const { id } = req.params;
  if (typeof id !== "string" || !ObjectId.isValid(id)) {
    return res.status(400).json({ error: "Ungültige ID" });
  }

  const db = getDB();
  const audioFiles = db.collection<AudioFile>("audioFiles");

  const track = await verifyTrackOwnership(id, req.userId!);

  if (!track) {
    return res.status(404).json({ error: "Track nicht gefunden" });
  }

  const { filename, contentType } = parseResult.data;

  if (!contentType.startsWith("image/")) {
    return res.status(400).json({ error: "Nur Bilddateien erlaubt" });
  }

  const key = generateObjectKey(`covers/${req.userId}`, filename);
  const uploadUrl = await getUploadUrl(key, contentType);

  await audioFiles.updateOne({ _id: track._id }, { $set: { coverKey: key, updatedAt: new Date() } });

  void notifyForTrack(track, req.userId!, "collab_track_cover");

  res.json({ uploadUrl, key });
}

// Track löschen
export async function deleteAudioFile(req: AuthRequest, res: Response) {

    const { id } = req.params;
    if (typeof id !== "string" || !ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Ungültige ID" });
    }

  const db = getDB();
  const audioFiles = db.collection<AudioFile>("audioFiles");

  const track = await verifyTrackOwnership(id, req.userId!);

  if (!track) {
    return res.status(404).json({ error: "Track nicht gefunden" });
  }

  for (const v of track.versions ?? []) {
    await safeDelete(v.key);
    await safeDelete(v.projectKey);
  }
  await safeDelete(track.coverKey);

  await audioFiles.deleteOne({ _id: track._id });
  await dropSavedShares(track.shareToken, track.projectShareToken);

  const playlist = await db
    .collection<Playlist>("playlists")
    .findOne({ _id: track.playlistId });
  if (playlist) {
    void notifyCollabActivity(playlist, req.userId!, "collab_track_removed", {
      trackTitle: track.title,
    });
  }

  res.json({ message: "Track gelöscht" });
}

// Streamen (nur Owner, eingeloggt)
export async function streamAudioFile(req: AuthRequest, res: Response) {

  const { id } = req.params;
  if (typeof id !== "string" || !ObjectId.isValid(id)) {
    return res.status(400).json({ error: "Ungültige ID" });
  }

  const db = getDB();
  const audioFiles = db.collection<AudioFile>("audioFiles");

  const track = await verifyTrackOwnership(id, req.userId!);

  if (!track) {
    return res.status(404).json({ error: "Track nicht gefunden" });
  }

  if (!track.key) {
    return res.status(404).json({ error: "Kein Audio für diesen Eintrag" });
  }
  void notifyListen(track, req.userId);
  const streamUrl = await getDownloadUrl(track.key);
  res.json({ streamUrl });
}

// Teilen aktivieren
export async function enableShare(req: AuthRequest, res: Response) {

    const { id } = req.params;
    if (typeof id !== "string" || !ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Ungültige ID" });
    }

  const db = getDB();
  const audioFiles = db.collection<AudioFile>("audioFiles");

  const track = await verifyTrackOwnership(id, req.userId!);

  if (!track) {
    return res.status(404).json({ error: "Track nicht gefunden" });
  }

  // Falls schon ein Token existiert, wiederverwenden, sonst neu generieren
  const shareToken = track.shareToken ?? randomBytes(24).toString("hex");

  const set: Partial<AudioFile> = {
    shareEnabled: true,
    shareToken,
    updatedAt: new Date(),
  };
  if (typeof req.body?.shareProject === "boolean") {
    set.shareProject = req.body.shareProject;
  }

  await audioFiles.updateOne({ _id: track._id }, { $set: set });

  res.json({
    shareToken,
    shareUrl: `${process.env.FRONTEND_URL}/share/${shareToken}`,
    shareProject: set.shareProject ?? track.shareProject ?? false,
  });
}

// Teilen deaktivieren
export async function disableShare(req: AuthRequest, res: Response) {

    const { id } = req.params;
    if (typeof id !== "string" || !ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Ungültige ID" });
    }

  const existing = await verifyTrackOwnership(id, req.userId!);
  if (!existing) {
    return res.status(404).json({ error: "Track nicht gefunden" });
  }

  const db = getDB();
  const audioFiles = db.collection<AudioFile>("audioFiles");

  const result = await audioFiles.findOneAndUpdate(
    { _id: existing._id },
    { $set: { shareEnabled: false, updatedAt: new Date() } },
    { returnDocument: "after" }
  );

  if (!result) {
    return res.status(404).json({ error: "Track nicht gefunden" });
  }

  await dropSavedShares(result.shareToken);
  res.json({ message: "Teilen deaktiviert" });
}

// Eigenen Link nur für die Projektdatei aktivieren
export async function enableProjectShare(req: AuthRequest, res: Response) {
  const track = await verifyTrackOwnership(req.params.id, req.userId!);
  if (!track) return res.status(404).json({ error: "Track nicht gefunden" });

  const version = findSelectedVersion(track);
  if (!version?.projectKey) {
    return res
      .status(400)
      .json({ error: "Die Hauptversion hat keine Projektdatei zum Teilen." });
  }

  const token = track.projectShareToken ?? randomBytes(24).toString("hex");
  await getDB()
    .collection<AudioFile>("audioFiles")
    .updateOne(
      { _id: track._id },
      { $set: { projectShareEnabled: true, projectShareToken: token, updatedAt: new Date() } }
    );

  res.json({
    token,
    shareUrl: `${process.env.FRONTEND_URL}/share/project/${token}`,
  });
}

export async function disableProjectShare(req: AuthRequest, res: Response) {
  const track = await verifyTrackOwnership(req.params.id, req.userId!);
  if (!track) return res.status(404).json({ error: "Track nicht gefunden" });

  await getDB()
    .collection<AudioFile>("audioFiles")
    .updateOne(
      { _id: track._id },
      { $set: { projectShareEnabled: false, updatedAt: new Date() } }
    );

  await dropSavedShares(track.projectShareToken);
  res.json({ message: "Projekt-Teilen deaktiviert" });
}

// Öffentlicher Projekt-Download (KEIN Login nötig)
export async function getSharedProject(req: AuthRequest, res: Response) {
  const token = param(req.params.token);
  if (!token) return res.status(400).json({ error: "Ungültiger Link" });

  const track = await getDB()
    .collection<AudioFile>("audioFiles")
    .findOne({ projectShareToken: token, projectShareEnabled: true });

  if (!track) {
    return res.status(404).json({ error: "Link ungültig oder deaktiviert" });
  }

  const version = findSelectedVersion(track);
  if (!version?.projectKey) {
    return res.status(404).json({ error: "Keine Projektdatei verfügbar" });
  }

  const filename = version.projectFilename ?? "projekt.zip";
  const url = await getDownloadUrlAttachment(version.projectKey, filename);
  if (!req.userId || !track.owner.equals(req.userId)) {
    void logTrackEvent(track._id!, track.owner, req.userId, "download");
  }
  res.json({ url, filename, trackTitle: track.title });
}

// Öffentliches Streamen über Share-Link (KEIN Login nötig)
export async function streamSharedAudioFile(req: AuthRequest, res: Response) {
  const db = getDB();
  const audioFiles = db.collection<AudioFile>("audioFiles");

  const track = await audioFiles.findOne({
    shareToken: req.params.shareToken,
    shareEnabled: true,
  });

  if (!track) {
    return res.status(404).json({ error: "Link ungültig oder abgelaufen" });
  }

  const version = findSelectedVersion(track);
  const streamKey = version?.key ?? track.key;
  if (!streamKey) {
    return res.status(404).json({ error: "Kein Audio verfügbar" });
  }
  // Passwortschutz (music+): Owner ist ausgenommen.
  if (track.sharePasswordHash && !(req.userId && track.owner.equals(req.userId))) {
    const key =
      (typeof req.query.k === "string" && req.query.k) ||
      (typeof req.headers["x-share-key"] === "string" &&
        (req.headers["x-share-key"] as string)) ||
      "";
    if (!key || !verifyShareUnlock(key, track.shareToken!)) {
      return res.status(401).json({
        error: "Passwort erforderlich",
        needsPassword: true,
        title: track.title,
      });
    }
  }

  void notifyListen(track, req.userId);
  const streamUrl = await getDownloadUrl(streamKey);

  let projectUrl: string | undefined;
  let projectFilename: string | undefined;
  if (track.shareProject && version?.projectKey) {
    projectFilename = version.projectFilename ?? "projekt.zip";
    projectUrl = await getDownloadUrlAttachment(version.projectKey, projectFilename);
  }

  res.json({
    _id: track._id!.toString(),
    streamUrl,
    title: track.title,
    artist: track.artist,
    description: track.description,
    bpm: version?.bpm ?? track.bpm ?? null,
    musicalKey: version?.musicalKey ?? track.musicalKey ?? null,
    projectUrl,
    projectFilename,
  });
}

// PATCH /audio-files/:id/share-password  { password: string | null }  (Owner, music+)
export async function setTrackSharePassword(req: AuthRequest, res: Response) {
  const parsed = setTrackSharePasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  const track = await verifyTrackOwnership(req.params.id, req.userId!);
  if (!track) return res.status(404).json({ error: "Track nicht gefunden" });

  if (!(await requesterHasPlus(req.userId!))) {
    return res
      .status(403)
      .json({ error: "Passwortschutz erfordert music+", upgradeRequired: true });
  }

  const audioFiles = getDB().collection<AudioFile>("audioFiles");
  if (parsed.data.password === null) {
    await audioFiles.updateOne(
      { _id: track._id },
      { $unset: { sharePasswordHash: "" }, $set: { updatedAt: new Date() } }
    );
  } else {
    const hash = await bcrypt.hash(parsed.data.password, 10);
    await audioFiles.updateOne(
      { _id: track._id },
      { $set: { sharePasswordHash: hash, updatedAt: new Date() } }
    );
  }

  const updated = await audioFiles.findOne({ _id: track._id });
  res.json({ sharePasswordSet: !!updated?.sharePasswordHash });
}

// POST /audio-files/public/unlock/:shareToken  { password }  (kein Login)
export async function unlockTrackShare(req: AuthRequest, res: Response) {
  const shareToken = param(req.params.shareToken);
  if (!shareToken) return res.status(400).json({ error: "Ungültiger Link" });

  const parsed = unlockShareSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Passwort erforderlich" });

  const track = await getDB()
    .collection<AudioFile>("audioFiles")
    .findOne({ shareToken, shareEnabled: true });
  if (!track || !track.sharePasswordHash) {
    return res.status(404).json({ error: "Track nicht gefunden" });
  }

  const ok = await bcrypt.compare(parsed.data.password, track.sharePasswordHash);
  if (!ok) return res.status(401).json({ error: "Falsches Passwort" });

  res.json({ unlockKey: generateShareUnlock(shareToken) });
}

export async function reorderAudioFiles(req: AuthRequest, res: Response) {
  const { orderedIds } = req.body as { orderedIds?: string[] };
  if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
    return res.status(400).json({ error: "orderedIds erforderlich" });
  }

  const { playlistId } = req.params;
  if (typeof playlistId !== "string" || !ObjectId.isValid(playlistId)) {
    return res.status(400).json({ error: "Ungültige PlaylistID" });
  }

  const playlist = await verifyPlaylistOwnership(playlistId, req.userId!);
  if (!playlist) {
    return res.status(404).json({ error: "Playlist nicht gefunden" });
  }

  const db = getDB();
  const audioFiles = db.collection<AudioFile>("audioFiles");

  // Alle gesendeten IDs müssen zu dieser Playlist gehören (Owner nicht relevant –
  // Tracks können auch Mitgliedern gehören).
  const owned = await audioFiles
    .find({
      _id: { $in: orderedIds.map((id) => new ObjectId(id)) },
      playlistId: playlist._id,
    })
    .project({ _id: 1 })
    .toArray();

  if (owned.length !== orderedIds.length) {
    return res.status(400).json({ error: "Ungültige Track-Liste" });
  }

  // orderedIds darf eine Teilmenge sein (gefilterte Ansicht). Wir laden die
  // volle Playlist-Reihenfolge und füllen die "sichtbaren" Slots neu; alle
  // anderen Einträge behalten ihre Position.
  const all = await audioFiles
    .find({ playlistId: playlist._id })
    .sort({ order: 1, createdAt: -1 })
    .project({ _id: 1 })
    .toArray();

  const visible = new Set(orderedIds);
  let vi = 0;
  const finalOrder = all.map((t) =>
    visible.has(t._id.toString()) ? orderedIds[vi++] : t._id.toString()
  );

  const bulkOps = finalOrder.map((id, index) => ({
    updateOne: {
      filter: { _id: new ObjectId(id) },
      update: { $set: { order: index, updatedAt: new Date() } },
    },
  }));

  await audioFiles.bulkWrite(bulkOps);
  void notifyCollabActivity(playlist, req.userId!, "collab_reordered");
  res.json({ message: "Reihenfolge gespeichert" });
}

/* ============================ Track-Versionen ============================ */

// Upload einer weiteren Version vorbereiten
export async function initVersionUpload(req: AuthRequest, res: Response) {
  const parsed = initVersionUploadSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  const track = await verifyTrackOwnership(req.params.id, req.userId!);
  if (!track) return res.status(404).json({ error: "Track nicht gefunden" });

  const { filename, contentType, fileSize } = parsed.data;
  const isProject = track.kind === "project";

  if (isProject) {
    if (!isAllowedProjectFile(filename, contentType)) {
      return res.status(400).json({ error: "Nur .zip- oder .rar-Dateien erlaubt" });
    }
  } else if (!isAllowedAudioType(contentType)) {
    return res.status(400).json({ error: "Dateityp nicht erlaubt" });
  }

  const limit = await assertWithinLimit(new ObjectId(req.userId), fileSize);
  if (!limit.ok) return res.status(limit.status).json({ error: limit.error });

  const key = generateObjectKey(
    `${isProject ? "projects" : "audio"}/${req.userId}`,
    filename
  );
  const uploadUrl = await getUploadUrl(key, contentType);
  res.json({ uploadUrl, key });
}

// Neue Version bestätigen -> wird automatisch Hauptversion
export async function confirmVersionUpload(req: AuthRequest, res: Response) {
  const parsed = confirmVersionUploadSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  const track = await verifyTrackOwnership(req.params.id, req.userId!);
  if (!track) return res.status(404).json({ error: "Track nicht gefunden" });

  const { key, originalFilename, fileSize, mimeType } = parsed.data;
  const isProject = track.kind === "project";
  const version = isProject
    ? buildProjectVersion(key, originalFilename, fileSize)
    : buildVersion(key, originalFilename, fileSize, mimeType);

  const db = getDB();
  const audioFiles = db.collection<AudioFile>("audioFiles");

  await audioFiles.updateOne(
    { _id: track._id },
    {
      $set: {
        versions: [...track.versions, version],
        selectedVersionId: version._id,
        updatedAt: new Date(),
      },
    }
  );
  await writeMirror(audioFiles, track._id!);

  const playlist = await db
    .collection<Playlist>("playlists")
    .findOne({ _id: track.playlistId });
  if (playlist) {
    void notifyCollabActivity(playlist, req.userId!, "collab_version_added", {
      trackId: track._id,
      trackTitle: track.title,
    });
  }

  if (!isProject) processAudioMetadata(track._id!, version._id, key);
  await sendTrack(res, track._id!);
}

// Version-Metadaten setzen (BPM / Key / Label) - z.B. aus Browser-Analyse
export async function updateVersion(req: AuthRequest, res: Response) {
  const parsed = updateVersionSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  const track = await verifyTrackOwnership(req.params.id, req.userId!);
  if (!track) return res.status(404).json({ error: "Track nicht gefunden" });

  const vid = param(req.params.vid);
  if (!vid || !ObjectId.isValid(vid)) {
    return res.status(400).json({ error: "Ungültige Versions-ID" });
  }
  const versionId = new ObjectId(vid);
  const version = track.versions.find((v) => v._id.equals(versionId));
  if (!version) return res.status(404).json({ error: "Version nicht gefunden" });

  const set: Record<string, unknown> = {};
  if (parsed.data.bpm !== undefined) set["versions.$.bpm"] = parsed.data.bpm;
  if (parsed.data.musicalKey !== undefined) {
    set["versions.$.musicalKey"] = normalizeKey(parsed.data.musicalKey) || null;
  }
  if (parsed.data.label !== undefined) set["versions.$.label"] = parsed.data.label;

  const db = getDB();
  const audioFiles = db.collection<AudioFile>("audioFiles");

  if (Object.keys(set).length > 0) {
    await audioFiles.updateOne(
      { _id: track._id, "versions._id": versionId },
      { $set: set }
    );
  }

  await writeMirror(audioFiles, track._id!);
  // Skip the browser's automatic BPM/key analysis right after upload — that
  // isn't a deliberate edit and would double up with "track added".
  const isFreshUpload = Date.now() - new Date(track.createdAt).getTime() < 120_000;
  if (!isFreshUpload) {
    const changes: Array<[string, string | undefined, string | undefined]> = [];
    if (parsed.data.bpm !== undefined && parsed.data.bpm !== (version.bpm ?? null))
      changes.push([
        "bpm",
        version.bpm != null ? String(version.bpm) : undefined,
        parsed.data.bpm != null ? String(parsed.data.bpm) : undefined,
      ]);
    if (
      parsed.data.musicalKey !== undefined &&
      (normalizeKey(parsed.data.musicalKey) || null) !== (version.musicalKey ?? null)
    )
      changes.push([
        "key",
        version.musicalKey ?? undefined,
        normalizeKey(parsed.data.musicalKey) || undefined,
      ]);
    if (parsed.data.label !== undefined && parsed.data.label !== version.label)
      changes.push(["label", version.label, parsed.data.label]);
    for (const [field, from, to] of changes) {
      void notifyForTrack(track, req.userId!, "collab_track_edited", {
        field,
        from: from ?? null,
        to: to ?? null,
      });
    }
  }
  await sendTrack(res, track._id!);
}

// Hauptversion umschalten
export async function selectVersion(req: AuthRequest, res: Response) {
  const track = await verifyTrackOwnership(req.params.id, req.userId!);
  if (!track) return res.status(404).json({ error: "Track nicht gefunden" });

  const vid = param(req.params.vid);
  if (!vid || !ObjectId.isValid(vid)) {
    return res.status(400).json({ error: "Ungültige Versions-ID" });
  }
  const versionId = new ObjectId(vid);
  if (!track.versions.some((v) => v._id.equals(versionId))) {
    return res.status(404).json({ error: "Version nicht gefunden" });
  }

  const db = getDB();
  const audioFiles = db.collection<AudioFile>("audioFiles");

  await audioFiles.updateOne(
    { _id: track._id },
    { $set: { selectedVersionId: versionId, updatedAt: new Date() } }
  );
  await writeMirror(audioFiles, track._id!);
  void notifyForTrack(track, req.userId!, "collab_version_selected");

  await sendTrack(res, track._id!);
}

// Version löschen (nicht die letzte)
export async function deleteVersion(req: AuthRequest, res: Response) {
  const track = await verifyTrackOwnership(req.params.id, req.userId!);
  if (!track) return res.status(404).json({ error: "Track nicht gefunden" });

  const vid = param(req.params.vid);
  if (!vid || !ObjectId.isValid(vid)) {
    return res.status(400).json({ error: "Ungültige Versions-ID" });
  }
  const versionId = new ObjectId(vid);
  const version = track.versions.find((v) => v._id.equals(versionId));
  if (!version) return res.status(404).json({ error: "Version nicht gefunden" });

  if (track.versions.length <= 1) {
    return res
      .status(400)
      .json({ error: "Die letzte Version kann nicht gelöscht werden. Lösche stattdessen den Track." });
  }

  await safeDelete(version.key);
  await safeDelete(version.projectKey);

  const remaining = track.versions.filter((v) => !v._id.equals(versionId));
  // War es die Hauptversion -> neueste übrige wählen
  const stillSelected = track.selectedVersionId.equals(versionId)
    ? remaining[remaining.length - 1]._id
    : track.selectedVersionId;

  const db = getDB();
  const audioFiles = db.collection<AudioFile>("audioFiles");

  await audioFiles.updateOne(
    { _id: track._id },
    {
      $set: {
        versions: remaining,
        selectedVersionId: stillSelected,
        updatedAt: new Date(),
      },
    }
  );
  await writeMirror(audioFiles, track._id!);
  void notifyForTrack(track, req.userId!, "collab_version_removed");

  await sendTrack(res, track._id!);
}

/* ============================ Projektdateien ============================ */

async function loadVersionForProject(req: AuthRequest, res: Response) {
  const track = await verifyTrackOwnership(req.params.id, req.userId!);
  if (!track) {
    res.status(404).json({ error: "Track nicht gefunden" });
    return null;
  }
  const vid = param(req.params.vid);
  if (!vid || !ObjectId.isValid(vid)) {
    res.status(400).json({ error: "Ungültige Versions-ID" });
    return null;
  }
  const versionId = new ObjectId(vid);
  const version = track.versions.find((v) => v._id.equals(versionId));
  if (!version) {
    res.status(404).json({ error: "Version nicht gefunden" });
    return null;
  }
  return { track, version, versionId };
}

export async function initVersionProject(req: AuthRequest, res: Response) {
  const parsed = initVersionProjectSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  const ctx = await loadVersionForProject(req, res);
  if (!ctx) return;

  const { filename, contentType, fileSize } = parsed.data;
  if (!isAllowedProjectFile(filename, contentType)) {
    return res.status(400).json({ error: "Nur .zip- oder .rar-Dateien erlaubt" });
  }

  const extra = fileSize - (ctx.version.projectSize ?? 0); // ersetzt ggf. bestehende
  const limit = await assertWithinLimit(new ObjectId(req.userId), Math.max(0, extra));
  if (!limit.ok) return res.status(limit.status).json({ error: limit.error });

  const key = generateObjectKey(`projects/${req.userId}`, filename);
  const uploadUrl = await getUploadUrl(key, contentType);
  res.json({ uploadUrl, key });
}

export async function confirmVersionProject(req: AuthRequest, res: Response) {
  const parsed = confirmVersionProjectSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  const ctx = await loadVersionForProject(req, res);
  if (!ctx) return;

  const { key, filename, fileSize } = parsed.data;
  const db = getDB();
  const audioFiles = db.collection<AudioFile>("audioFiles");

  // altes Projekt-Objekt aufräumen, falls es ersetzt wird
  if (ctx.version.projectKey && ctx.version.projectKey !== key) {
    await safeDelete(ctx.version.projectKey);
  }

  await audioFiles.updateOne(
    { _id: ctx.track._id, "versions._id": ctx.versionId },
    {
      $set: {
        "versions.$.projectKey": key,
        "versions.$.projectFilename": filename,
        "versions.$.projectSize": fileSize,
        updatedAt: new Date(),
      },
    }
  );

  void notifyForTrack(ctx.track, req.userId!, "collab_version_added");

  await sendTrack(res, ctx.track._id!);
}

export async function downloadVersionProject(req: AuthRequest, res: Response) {
  const ctx = await loadVersionForProject(req, res);
  if (!ctx) return;

  if (!ctx.version.projectKey) {
    return res.status(404).json({ error: "Keine Projektdatei vorhanden" });
  }

  const url = await getDownloadUrlAttachment(
    ctx.version.projectKey,
    ctx.version.projectFilename ?? "projekt.zip"
  );
  if (!ctx.track.owner.equals(req.userId!)) {
    void logTrackEvent(ctx.track._id!, ctx.track.owner, req.userId, "download");
  }
  res.json({ url });
}

/**
 * Frontend calls this once a play has passed the 15-second threshold.
 * optionalAuth — anonymous listens are logged with userId = null.
 */
export async function logListen(req: AuthRequest, res: Response) {
  const id = param(req.params.id);
  if (!id || !ObjectId.isValid(id)) {
    return res.status(400).json({ error: "Ungültige ID" });
  }
  const db = getDB();
  const track = await db
    .collection<AudioFile>("audioFiles")
    .findOne({ _id: new ObjectId(id) }, { projection: { owner: 1 } });
  if (!track) return res.status(404).json({ error: "Track nicht gefunden" });

  // Don't count the owner listening to their own track.
  if (req.userId && track.owner.equals(req.userId)) {
    return res.json({ ok: true, counted: false });
  }

  // Light dedup for logged-in users: one listen per 20s per track.
  if (req.userId) {
    const recent = await db.collection<TrackEvent>("trackEvents").findOne({
      trackId: track._id,
      userId: new ObjectId(req.userId),
      type: "listen",
      createdAt: { $gt: new Date(Date.now() - 20_000) },
    });
    if (recent) return res.json({ ok: true, counted: false });
  }

  await logTrackEvent(track._id!, track.owner, req.userId, "listen");
  res.json({ ok: true, counted: true });
}

// Alle Detail-Infos + Zähler für das Info-Fenster
export async function getAudioFileInfo(req: AuthRequest, res: Response) {
  const track = await verifyTrackOwnership(req.params.id, req.userId!);
  if (!track) return res.status(404).json({ error: "Track nicht gefunden" });

  const version = findSelectedVersion(track);
  const counts = await trackCounts(track._id!);
  const playlist = await getDB()
    .collection<Playlist>("playlists")
    .findOne({ _id: track.playlistId }, { projection: { name: 1 } });

  res.json({
    _id: track._id!.toString(),
    title: track.title,
    artist: track.artist ?? null,
    description: track.description ?? null,
    kind: track.kind ?? "track",
    playlistName: playlist?.name ?? null,
    createdAt: track.createdAt,
    updatedAt: track.updatedAt,
    coverUrl: track.coverKey ? await getDownloadUrl(track.coverKey) : null,
    versionCount: track.versions?.length ?? 0,
    selectedVersion: version
      ? {
          label: version.label,
          originalFilename: version.originalFilename ?? null,
          fileSize: version.fileSize ?? null,
          mimeType: version.mimeType ?? null,
          duration: version.duration ?? null,
          bpm: version.bpm ?? null,
          musicalKey: version.musicalKey ?? null,
          projectFilename: version.projectFilename ?? null,
          projectSize: version.projectSize ?? null,
          createdAt: version.createdAt,
        }
      : null,
    shareEnabled: !!track.shareEnabled,
    projectShareEnabled: !!track.projectShareEnabled,
    stats: counts,
  });
}

export async function deleteVersionProject(req: AuthRequest, res: Response) {
  const ctx = await loadVersionForProject(req, res);
  if (!ctx) return;

  await safeDelete(ctx.version.projectKey);

  const db = getDB();
  const audioFiles = db.collection<AudioFile>("audioFiles");
  await audioFiles.updateOne(
    { _id: ctx.track._id, "versions._id": ctx.versionId },
    {
      $unset: {
        "versions.$.projectKey": "",
        "versions.$.projectFilename": "",
        "versions.$.projectSize": "",
      },
      $set: { updatedAt: new Date() },
    }
  );

  void notifyForTrack(ctx.track, req.userId!, "collab_version_removed");

  await sendTrack(res, ctx.track._id!);
}