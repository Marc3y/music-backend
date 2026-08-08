import { Response } from "express";
import { ObjectId } from "mongodb";
import { getDB } from "../config/db";
import { Playlist } from "../models/Playlist";
import { AuthRequest } from "../middleware/auth.middleware";
import { createPlaylistSchema, updatePlaylistSchema, uploadUrlRequestSchema } from "../utils/validators";
import { generateObjectKey, getUploadUrl, getDownloadUrl, deleteObject } from "../services/storage.service";
import { AudioFile } from "../models/AudioFile";


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

  const db = getDB();
  const playlists = db.collection<Playlist>("playlists");

  const playlist = await playlists.findOne({
    _id: new ObjectId(id),
    owner: new ObjectId(req.userId),
  });

  if (!playlist) {
    return res.status(404).json({ error: "Playlist nicht gefunden" });
  }

  const coverUrl = playlist.coverKey ? await getDownloadUrl(playlist.coverKey) : null;
  res.json({ ...playlist, coverUrl });
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

  const db = getDB();
  const playlists = db.collection<Playlist>("playlists");

  const result = await playlists.findOneAndUpdate(
    { _id: new ObjectId(id), owner: new ObjectId(req.userId) },
    { $set: { ...parseResult.data, updatedAt: new Date() } },
    { returnDocument: "after" }
  );

  if (!result) {
    return res.status(404).json({ error: "Playlist nicht gefunden" });
  }

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
      await deleteObject(track.key);
      if (track.coverKey) await deleteObject(track.coverKey);
    }
  
    await audioFiles.deleteMany({ playlistId: playlist._id });
  
    if (playlist.coverKey) {
      await deleteObject(playlist.coverKey);
    }
  
    await playlists.deleteOne({ _id: playlist._id });
  
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

  const db = getDB();
  const playlists = db.collection<Playlist>("playlists");

  const playlist = await playlists.findOne({
    _id: new ObjectId(id),
    owner: new ObjectId(req.userId),
  });

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
  await playlists.updateOne({ _id: playlist._id }, { $set: { coverKey: key, updatedAt: new Date() } });

  res.json({ uploadUrl, key });
}