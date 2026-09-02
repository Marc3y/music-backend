import { Response } from "express";
import bcrypt from "bcrypt";
import { ObjectId } from "mongodb";
import { getDB } from "../config/db";
import { User } from "../models/User";
import { Playlist } from "../models/Playlist";
import { AudioFile } from "../models/AudioFile";
import { AuthRequest } from "../middleware/auth.middleware";
import {
  updateUsernameSchema,
  changePasswordRequestSchema,
  codeConfirmSchema,
  deleteAccountRequestSchema,
  uploadUrlRequestSchema,
  addSavedShareSchema,
} from "../utils/validators";
import { generateSixDigitCode } from "../utils/tokens";
import { usernameTaken } from "../utils/users";
import { findSelectedVersion } from "../utils/trackVersions";
import { SavedShare } from "../models/SavedShare";
import { DEFAULT_STORAGE_LIMIT_BYTES } from "../config/limits";
import {
  sendPasswordChangeCodeEmail,
  sendAccountDeletionCodeEmail,
} from "../services/email.service";
import {
  generateObjectKey,
  getUploadUrl,
  getDownloadUrl,
  deleteObject,
} from "../services/storage.service";

const CODE_TTL_MS = 15 * 60 * 1000;

function clearAuthCookies(res: Response) {
  res.clearCookie("accessToken");
  res.clearCookie("refreshToken");
}

// S3-Objekt löschen, ohne dass ein fehlendes Objekt den Ablauf abbricht
async function safeDeleteObject(key?: string) {
  if (!key) return;
  try {
    await deleteObject(key);
  } catch (err) {
    console.error(`⚠️  Objekt konnte nicht gelöscht werden (${key}):`, err);
  }
}

async function serializeUser(user: User) {
  return {
    id: user._id!.toString(),
    email: user.email,
    username: user.username,
    avatarUrl: user.avatarKey ? await getDownloadUrl(user.avatarKey) : null,
  };
}

export function resolveStorageLimit(user: Pick<User, "storageLimit">): number {
  return typeof user.storageLimit === "number"
    ? user.storageLimit
    : DEFAULT_STORAGE_LIMIT_BYTES;
}

// Belegter Speicher = Audio ALLER Versionen + alle Projektdateien
export async function getStorageUsage(userId: ObjectId): Promise<number> {
  const db = getDB();
  const audioFiles = db.collection<AudioFile>("audioFiles");
  const [row] = await audioFiles
    .aggregate<{ used: number }>([
      { $match: { owner: userId } },
      {
        $project: {
          audio: { $sum: "$versions.fileSize" },
          project: {
            $sum: {
              $map: {
                input: { $ifNull: ["$versions", []] },
                as: "v",
                in: { $ifNull: ["$$v.projectSize", 0] },
              },
            },
          },
        },
      },
      { $group: { _id: null, used: { $sum: { $add: ["$audio", "$project"] } } } },
    ])
    .toArray();
  return row?.used ?? 0;
}

// Gesamtgröße eines Tracks (alle Versionen: Audio + Projekt)
function trackTotalSize(t: AudioFile): number {
  return (t.versions ?? []).reduce(
    (s, v) => s + (v.fileSize ?? 0) + (v.projectSize ?? 0),
    0
  );
}

export async function getStorageSummary(req: AuthRequest, res: Response) {
  const db = getDB();
  const users = db.collection<User>("users");

  const userId = new ObjectId(req.userId);
  const user = await users.findOne({ _id: userId });
  if (!user) {
    return res.status(404).json({ error: "User nicht gefunden" });
  }

  const used = await getStorageUsage(userId);
  res.json({ used, limit: resolveStorageLimit(user) });
}

export async function getUsage(req: AuthRequest, res: Response) {
  const db = getDB();
  const users = db.collection<User>("users");
  const audioFiles = db.collection<AudioFile>("audioFiles");
  const playlists = db.collection<Playlist>("playlists");

  const userId = new ObjectId(req.userId);
  const user = await users.findOne({ _id: userId });
  if (!user) {
    return res.status(404).json({ error: "User nicht gefunden" });
  }

  const allTracks = await audioFiles.find({ owner: userId }).toArray();

  const playlistIds = [...new Set(allTracks.map((t) => t.playlistId.toString()))];
  const playlistDocs = await playlists
    .find({ _id: { $in: playlistIds.map((id) => new ObjectId(id)) } })
    .toArray();
  const nameById = new Map(playlistDocs.map((p) => [p._id!.toString(), p.name]));

  const tracks = allTracks
    .map((t) => ({
      _id: t._id!.toString(),
      title: t.title,
      kind: t.kind ?? "track",
      size: trackTotalSize(t),
      versionCount: (t.versions ?? []).length,
      playlistId: t.playlistId.toString(),
      playlistName: nameById.get(t.playlistId.toString()) ?? null,
      status: t.status,
    }))
    .sort((a, b) => b.size - a.size);

  const projects = allTracks
    .flatMap((t) =>
      (t.versions ?? [])
        .filter((v) => v.projectKey && v.projectSize)
        .map((v) => ({
          trackId: t._id!.toString(),
          versionId: v._id.toString(),
          trackTitle: t.title,
          versionLabel: v.label,
          playlistName: nameById.get(t.playlistId.toString()) ?? null,
          filename: v.projectFilename ?? "projekt.zip",
          size: v.projectSize ?? 0,
        }))
    )
    .sort((a, b) => b.size - a.size);

  const used = allTracks.reduce((sum, t) => sum + trackTotalSize(t), 0);

  res.json({ used, limit: resolveStorageLimit(user), tracks, projects });
}

export async function getMe(req: AuthRequest, res: Response) {
  const db = getDB();
  const users = db.collection<User>("users");

  const user = await users.findOne({ _id: new ObjectId(req.userId) });
  if (!user) {
    return res.status(404).json({ error: "User nicht gefunden" });
  }

  res.json(await serializeUser(user));
}

export async function updateUsername(req: AuthRequest, res: Response) {
  const parseResult = updateUsernameSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({ error: parseResult.error.issues[0].message });
  }

  const db = getDB();
  const users = db.collection<User>("users");
  const userId = new ObjectId(req.userId);

  if (await usernameTaken(parseResult.data.username, userId)) {
    return res.status(409).json({ error: "Dieser Username ist bereits vergeben" });
  }

  const user = await users.findOneAndUpdate(
    { _id: userId },
    { $set: { username: parseResult.data.username } },
    { returnDocument: "after" }
  );

  if (!user) {
    return res.status(404).json({ error: "User nicht gefunden" });
  }

  res.json(await serializeUser(user));
}

export async function getAvatarUploadUrl(req: AuthRequest, res: Response) {
  const parseResult = uploadUrlRequestSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({ error: parseResult.error.issues[0].message });
  }

  const { filename, contentType } = parseResult.data;
  if (!contentType.startsWith("image/")) {
    return res.status(400).json({ error: "Nur Bilddateien erlaubt" });
  }

  const db = getDB();
  const users = db.collection<User>("users");

  const user = await users.findOne({ _id: new ObjectId(req.userId) });
  if (!user) {
    return res.status(404).json({ error: "User nicht gefunden" });
  }

  // Altes Avatar-Objekt aufräumen
  await safeDeleteObject(user.avatarKey);

  const key = generateObjectKey(`avatars/${req.userId}`, filename);
  const uploadUrl = await getUploadUrl(key, contentType);

  await users.updateOne({ _id: user._id }, { $set: { avatarKey: key } });

  res.json({ uploadUrl, key });
}

export async function deleteAvatar(req: AuthRequest, res: Response) {
  const db = getDB();
  const users = db.collection<User>("users");

  const user = await users.findOne({ _id: new ObjectId(req.userId) });
  if (!user) {
    return res.status(404).json({ error: "User nicht gefunden" });
  }

  await safeDeleteObject(user.avatarKey);
  await users.updateOne({ _id: user._id }, { $unset: { avatarKey: "" } });

  res.json({ message: "Profilbild entfernt" });
}

export async function requestPasswordChange(req: AuthRequest, res: Response) {
  const parseResult = changePasswordRequestSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({ error: parseResult.error.issues[0].message });
  }

  const { currentPassword, newPassword } = parseResult.data;
  const db = getDB();
  const users = db.collection<User>("users");

  const user = await users.findOne({ _id: new ObjectId(req.userId) });
  if (!user) {
    return res.status(404).json({ error: "User nicht gefunden" });
  }

  const matches = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!matches) {
    return res.status(401).json({ error: "Aktuelles Passwort falsch" });
  }

  const pendingPasswordHash = await bcrypt.hash(newPassword, 10);
  const code = generateSixDigitCode();

  await users.updateOne(
    { _id: user._id },
    {
      $set: {
        pendingPasswordHash,
        passwordChangeCode: code,
        passwordChangeExpiry: new Date(Date.now() + CODE_TTL_MS),
      },
    }
  );

  await sendPasswordChangeCodeEmail(user.email, code);

  res.json({ message: "Bestätigungscode an deine E-Mail gesendet" });
}

export async function confirmPasswordChange(req: AuthRequest, res: Response) {
  const parseResult = codeConfirmSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({ error: parseResult.error.issues[0].message });
  }

  const db = getDB();
  const users = db.collection<User>("users");

  const user = await users.findOne({ _id: new ObjectId(req.userId) });
  if (!user) {
    return res.status(404).json({ error: "User nicht gefunden" });
  }

  if (!user.pendingPasswordHash || !user.passwordChangeCode) {
    return res.status(400).json({ error: "Keine Passwortänderung angefordert" });
  }

  if (user.passwordChangeCode !== parseResult.data.code) {
    return res.status(400).json({ error: "Ungültiger Code" });
  }

  if (!user.passwordChangeExpiry || user.passwordChangeExpiry < new Date()) {
    return res.status(400).json({ error: "Code abgelaufen" });
  }

  await users.updateOne(
    { _id: user._id },
    {
      $set: { passwordHash: user.pendingPasswordHash },
      $unset: {
        pendingPasswordHash: "",
        passwordChangeCode: "",
        passwordChangeExpiry: "",
      },
    }
  );

  clearAuthCookies(res);
  res.json({ message: "Passwort geändert. Bitte melde dich neu an." });
}

export async function requestAccountDeletion(req: AuthRequest, res: Response) {
  const parseResult = deleteAccountRequestSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({ error: parseResult.error.issues[0].message });
  }

  const db = getDB();
  const users = db.collection<User>("users");

  const user = await users.findOne({ _id: new ObjectId(req.userId) });
  if (!user) {
    return res.status(404).json({ error: "User nicht gefunden" });
  }

  const matches = await bcrypt.compare(parseResult.data.password, user.passwordHash);
  if (!matches) {
    return res.status(401).json({ error: "Passwort falsch" });
  }

  const code = generateSixDigitCode();
  await users.updateOne(
    { _id: user._id },
    {
      $set: {
        accountDeletionCode: code,
        accountDeletionExpiry: new Date(Date.now() + CODE_TTL_MS),
      },
    }
  );

  await sendAccountDeletionCodeEmail(user.email, code);

  res.json({ message: "Bestätigungscode an deine E-Mail gesendet" });
}

// Alle Daten eines Users unwiderruflich entfernen (DB + Objektspeicher)
async function deleteAllUserData(userId: ObjectId, user: User) {
  const db = getDB();
  const playlists = db.collection<Playlist>("playlists");
  const audioFiles = db.collection<AudioFile>("audioFiles");
  const users = db.collection<User>("users");

  const tracks = await audioFiles.find({ owner: userId }).toArray();
  for (const track of tracks) {
    for (const v of track.versions ?? []) {
      await safeDeleteObject(v.key);
      await safeDeleteObject(v.projectKey);
    }
    await safeDeleteObject(track.coverKey);
  }
  await audioFiles.deleteMany({ owner: userId });

  const userPlaylists = await playlists.find({ owner: userId }).toArray();
  for (const playlist of userPlaylists) {
    await safeDeleteObject(playlist.coverKey);
  }
  await playlists.deleteMany({ owner: userId });

  await db.collection<SavedShare>("savedShares").deleteMany({ userId });

  await safeDeleteObject(user.avatarKey);

  await users.deleteOne({ _id: userId });
}

export async function confirmAccountDeletion(req: AuthRequest, res: Response) {
  const parseResult = codeConfirmSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({ error: parseResult.error.issues[0].message });
  }

  const db = getDB();
  const users = db.collection<User>("users");

  const userId = new ObjectId(req.userId);
  const user = await users.findOne({ _id: userId });
  if (!user) {
    return res.status(404).json({ error: "User nicht gefunden" });
  }

  if (!user.accountDeletionCode) {
    return res.status(400).json({ error: "Keine Löschung angefordert" });
  }

  if (user.accountDeletionCode !== parseResult.data.code) {
    return res.status(400).json({ error: "Ungültiger Code" });
  }

  if (!user.accountDeletionExpiry || user.accountDeletionExpiry < new Date()) {
    return res.status(400).json({ error: "Code abgelaufen" });
  }

  await deleteAllUserData(userId, user);

  clearAuthCookies(res);
  res.json({ message: "Account gelöscht" });
}

/* ==================== Geteilte Sachen in der Mediathek ==================== */

async function resolveSharedTrack(type: "audio" | "project", token: string) {
  const audioFiles = getDB().collection<AudioFile>("audioFiles");
  return type === "audio"
    ? audioFiles.findOne({ shareToken: token, shareEnabled: true })
    : audioFiles.findOne({ projectShareToken: token, projectShareEnabled: true });
}

async function usernameLower(userId: ObjectId): Promise<string | null> {
  const u = await getDB()
    .collection<User>("users")
    .findOne({ _id: userId }, { projection: { username: 1 } });
  return u ? u.username.toLowerCase() : null;
}

export async function addSavedShare(req: AuthRequest, res: Response) {
  const parsed = addSavedShareSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  const { type, token } = parsed.data;
  const userId = new ObjectId(req.userId);

  if (type === "playlist") {
    const playlists = getDB().collection<Playlist>("playlists");
    const pl = await playlists.findOne({ shareToken: token, shareEnabled: true });
    if (!pl) return res.status(404).json({ error: "Link ungültig oder nicht mehr geteilt" });
    if (pl.owner.equals(userId)) {
      return res.status(400).json({ error: "Das ist deine eigene Playlist" });
    }
    if (pl.shareRestricted) {
      const uname = await usernameLower(userId);
      if (!uname || !(pl.allowedUsernames ?? []).includes(uname)) {
        return res.status(403).json({ error: "Kein Zugriff auf diese Playlist" });
      }
    }
  } else {
    const track = await resolveSharedTrack(type, token);
    if (!track) {
      return res.status(404).json({ error: "Link ungültig oder nicht mehr geteilt" });
    }
    if (track.owner.equals(userId)) {
      return res.status(400).json({ error: "Das ist dein eigener Eintrag" });
    }
  }

  await getDB()
    .collection<SavedShare>("savedShares")
    .updateOne(
      { userId, type, token },
      { $setOnInsert: { userId, type, token, createdAt: new Date() } },
      { upsert: true }
    );

  res.json({ message: "Zur Mediathek hinzugefügt" });
}

async function resolveSavedPlaylist(
  entry: SavedShare,
  userId: ObjectId
): Promise<Record<string, unknown> | null> {
  const playlists = getDB().collection<Playlist>("playlists");
  const pl =
    entry.type === "playlist"
      ? await playlists.findOne({ shareToken: entry.token, shareEnabled: true })
      : await playlists.findOne({ collabToken: entry.token, "collaborators.userId": userId });
  if (!pl) return null;

  if (entry.type === "playlist" && pl.shareRestricted) {
    const uname = await usernameLower(userId);
    if (!uname || !(pl.allowedUsernames ?? []).includes(uname)) return null;
  }

  const trackCount = await getDB()
    .collection<AudioFile>("audioFiles")
    .countDocuments({ playlistId: pl._id });

  return {
    _id: entry._id!.toString(),
    type: entry.type,
    token: entry.token,
    playlistId: pl._id!.toString(),
    title: pl.name,
    coverUrl: pl.coverKey ? await getDownloadUrl(pl.coverKey) : null,
    trackCount,
    addedAt: entry.createdAt,
  };
}

export async function listSavedShares(req: AuthRequest, res: Response) {
  const userId = new ObjectId(req.userId);
  const saved = getDB().collection<SavedShare>("savedShares");
  const entries = await saved.find({ userId }).sort({ createdAt: -1 }).toArray();

  const result: unknown[] = [];
  const staleIds: ObjectId[] = [];

  for (const entry of entries) {
    if (entry.type === "playlist" || entry.type === "collab") {
      const item = await resolveSavedPlaylist(entry, userId);
      if (item) result.push(item);
      else staleIds.push(entry._id!);
      continue;
    }

    const track = await resolveSharedTrack(entry.type, entry.token);
    if (!track) {
      staleIds.push(entry._id!);
      continue;
    }
    const version = findSelectedVersion(track);
    const withProject =
      entry.type === "project" ||
      (!!track.shareProject && !!version?.projectKey);

    result.push({
      _id: entry._id!.toString(),
      type: entry.type,
      token: entry.token,
      title: track.title,
      artist: track.artist,
      bpm: version?.bpm ?? track.bpm ?? null,
      musicalKey: version?.musicalKey ?? track.musicalKey ?? null,
      projectFilename: withProject ? version?.projectFilename : undefined,
      projectSize: withProject ? version?.projectSize : undefined,
      addedAt: entry.createdAt,
    });
  }

  if (staleIds.length) await saved.deleteMany({ _id: { $in: staleIds } });

  res.json(result);
}

export async function removeSavedShare(req: AuthRequest, res: Response) {
  const id = req.params.id;
  if (typeof id !== "string" || !ObjectId.isValid(id)) {
    return res.status(400).json({ error: "Ungültige ID" });
  }
  await getDB()
    .collection<SavedShare>("savedShares")
    .deleteOne({ _id: new ObjectId(id), userId: new ObjectId(req.userId) });
  res.json({ message: "Entfernt" });
}
