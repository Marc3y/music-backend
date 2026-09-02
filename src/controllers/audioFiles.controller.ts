import { processAudioMetadata } from "../services/metadata.service";
import { Response } from "express";
import { ObjectId } from "mongodb";
import { randomBytes } from "crypto";
import { getDB } from "../config/db";
import { AudioFile } from "../models/AudioFile";
import { Playlist } from "../models/Playlist";
import { AuthRequest } from "../middleware/auth.middleware";
import {
  initAudioUploadSchema,
  confirmAudioUploadSchema,
  updateAudioFileSchema,
  uploadUrlRequestSchema,
} from "../utils/validators";
import { isAllowedAudioType } from "../utils/audioValidation";
import { generateObjectKey, getUploadUrl, getDownloadUrl, deleteObject } from "../services/storage.service";
import { getStorageUsage, resolveStorageLimit } from "./account.controller";
import { User } from "../models/User";

// Playlist-Ownership prüfen (Hilfsfunktion, mehrfach gebraucht)
async function verifyPlaylistOwnership(playlistId: string, userId: string) {
  const db = getDB();
  const playlists = db.collection<Playlist>("playlists");
  return playlists.findOne({ _id: new ObjectId(playlistId), owner: new ObjectId(userId) });
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
  const userId = new ObjectId(req.userId);
  const db = getDB();
  const user = await db.collection<User>("users").findOne({ _id: userId });
  if (!user) {
    return res.status(404).json({ error: "User nicht gefunden" });
  }
  const used = await getStorageUsage(userId);
  if (used + fileSize > resolveStorageLimit(user)) {
    return res
      .status(403)
      .json({ error: "Speicherlimit erreicht. Lösche Tracks oder erhöhe dein Limit." });
  }

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

  const newAudioFile: AudioFile = {
    playlistId: playlist._id!,
    owner: new ObjectId(req.userId),
    key,
    originalFilename,
    title: defaultTitle,
    fileSize,
    mimeType,
    status: "processing", 
    order: Date.now(),
    shareEnabled: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const result = await audioFiles.insertOne(newAudioFile);
  processAudioMetadata(result.insertedId, key);
  res.status(201).json({ ...newAudioFile, _id: result.insertedId });
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
    ...t,
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

  const track = await audioFiles.findOne({
    _id: new ObjectId(id),
    owner: new ObjectId(req.userId),
  });

  if (!track) {
    return res.status(404).json({ error: "Track nicht gefunden" });
  }

  const coverUrl = track.coverKey ? await getDownloadUrl(track.coverKey) : null;
  res.json({ ...track, coverUrl });
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

  const db = getDB();
  const audioFiles = db.collection<AudioFile>("audioFiles");

  const result = await audioFiles.findOneAndUpdate(
    { _id: new ObjectId(id), owner: new ObjectId(req.userId) },
    { $set: { ...parseResult.data, updatedAt: new Date() } },
    { returnDocument: "after" }
  );

  if (!result) {
    return res.status(404).json({ error: "Track nicht gefunden" });
  }

  const coverUrl = result.coverKey ? await getDownloadUrl(result.coverKey) : null;
  res.json({ ...result, coverUrl });
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

  const track = await audioFiles.findOne({
    _id: new ObjectId(id),
    owner: new ObjectId(req.userId),
  });

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

  const track = await audioFiles.findOne({
    _id: new ObjectId(id),
    owner: new ObjectId(req.userId),
  });

  if (!track) {
    return res.status(404).json({ error: "Track nicht gefunden" });
  }

  await deleteObject(track.key);
  if (track.coverKey) {
    await deleteObject(track.coverKey);
  }

  await audioFiles.deleteOne({ _id: track._id });

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

  const track = await audioFiles.findOne({
    _id: new ObjectId(id),
    owner: new ObjectId(req.userId),
  });

  if (!track) {
    return res.status(404).json({ error: "Track nicht gefunden" });
  }

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

  const track = await audioFiles.findOne({
    _id: new ObjectId(id),
    owner: new ObjectId(req.userId),
  });

  if (!track) {
    return res.status(404).json({ error: "Track nicht gefunden" });
  }

  // Falls schon ein Token existiert, wiederverwenden, sonst neu generieren
  const shareToken = track.shareToken ?? randomBytes(24).toString("hex");

  await audioFiles.updateOne(
    { _id: track._id },
    { $set: { shareEnabled: true, shareToken, updatedAt: new Date() } }
  );

  res.json({ shareToken, shareUrl: `${process.env.FRONTEND_URL}/share/${shareToken}` });
}

// Teilen deaktivieren
export async function disableShare(req: AuthRequest, res: Response) {

    const { id } = req.params;
    if (typeof id !== "string" || !ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Ungültige ID" });
    }

  const db = getDB();
  const audioFiles = db.collection<AudioFile>("audioFiles");

  const result = await audioFiles.findOneAndUpdate(
    { _id: new ObjectId(id), owner: new ObjectId(req.userId) },
    { $set: { shareEnabled: false, updatedAt: new Date() } },
    { returnDocument: "after" }
  );

  if (!result) {
    return res.status(404).json({ error: "Track nicht gefunden" });
  }

  res.json({ message: "Teilen deaktiviert" });
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

  const streamUrl = await getDownloadUrl(track.key);
  res.json({
    streamUrl,
    title: track.title,
    artist: track.artist,
    description: track.description,
  });
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

  const owned = await audioFiles
    .find({
      _id: { $in: orderedIds.map((id) => new ObjectId(id)) },
      playlistId: playlist._id,
      owner: new ObjectId(req.userId),
    })
    .project({ _id: 1 })
    .toArray();

  if (owned.length !== orderedIds.length) {
    return res.status(400).json({ error: "Ungültige Track-Liste" });
  }

  const bulkOps = orderedIds.map((id, index) => ({
    updateOne: {
      filter: { _id: new ObjectId(id) },
      update: { $set: { order: index, updatedAt: new Date() } },
    },
  }));

  await audioFiles.bulkWrite(bulkOps);
  res.json({ message: "Reihenfolge gespeichert" });
}