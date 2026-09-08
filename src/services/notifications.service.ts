import { Response } from "express";
import { ObjectId } from "mongodb";
import { getDB } from "../config/db";
import {
  Notification,
  NotificationType,
  NotificationMeta,
} from "../models/Notification";
import { User } from "../models/User";
import { Playlist } from "../models/Playlist";
import { getDownloadUrl } from "./storage.service";
import { hasPlus } from "../config/limits";

/* ---------------- SSE-Registry ---------------- */

const clients = new Map<string, Set<Response>>();

export function addSseClient(userId: string, res: Response) {
  let set = clients.get(userId);
  if (!set) {
    set = new Set();
    clients.set(userId, set);
  }
  set.add(res);
}

export function removeSseClient(userId: string, res: Response) {
  const set = clients.get(userId);
  if (!set) return;
  set.delete(res);
  if (set.size === 0) clients.delete(userId);
}

function pushToUser(userId: string, event: string, data: unknown) {
  const set = clients.get(userId);
  if (!set) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of set) {
    try {
      res.write(payload);
    } catch {
      /* tote Verbindung – wird beim close aufgeräumt */
    }
  }
}

/* ---------------- Serialisierung ---------------- */

export async function serializeNotification(n: Notification) {
  return {
    id: n._id!.toString(),
    type: n.type,
    actor: {
      username: n.actorUsername,
      avatarUrl: n.actorAvatarKey ? await getDownloadUrl(n.actorAvatarKey) : null,
    },
    playlistId: n.playlistId?.toString() ?? null,
    playlistName: n.playlistName ?? null,
    trackId: n.trackId?.toString() ?? null,
    trackTitle: n.trackTitle ?? null,
    meta: n.meta ?? null,
    createdAt: n.createdAt.toISOString(),
    read: !!n.readAt,
  };
}

/* ---------------- Erstellung ---------------- */

interface CreateArgs {
  recipientId: ObjectId;
  actorId: ObjectId;
  type: NotificationType;
  playlistId?: ObjectId;
  playlistName?: string;
  trackId?: ObjectId;
  trackTitle?: string;
  meta?: NotificationMeta;
}

export async function createNotification(args: CreateArgs) {
  // Nie über die eigene Aktion benachrichtigen.
  if (args.recipientId.equals(args.actorId)) return;

  const db = getDB();
  const actor = await db
    .collection<User>("users")
    .findOne({ _id: args.actorId }, { projection: { username: 1, avatarKey: 1 } });
  if (!actor) return;

  const doc: Notification = {
    userId: args.recipientId,
    type: args.type,
    actorId: args.actorId,
    actorUsername: actor.username,
    actorAvatarKey: actor.avatarKey ?? null,
    playlistId: args.playlistId,
    playlistName: args.playlistName,
    trackId: args.trackId,
    trackTitle: args.trackTitle,
    meta: args.meta,
    createdAt: new Date(),
    readAt: null,
  };

  const { insertedId } = await db
    .collection<Notification>("notifications")
    .insertOne(doc);

  const serial = await serializeNotification({ ...doc, _id: insertedId });
  pushToUser(args.recipientId.toString(), "notification", serial);
}

/* ---------------- High-Level-Helfer ---------------- */

// Jemand hört einen Track → Owner benachrichtigen (nur wenn Owner music+ hat).
export async function notifyListen(
  track: { _id?: ObjectId; owner: ObjectId; title: string; playlistId?: ObjectId },
  listenerId: string | undefined
) {
  if (!listenerId || !ObjectId.isValid(listenerId)) return;
  const listener = new ObjectId(listenerId);
  if (track.owner.equals(listener)) return;

  const db = getDB();
  const owner = await db
    .collection<User>("users")
    .findOne({ _id: track.owner }, { projection: { tier: 1 } });
  if (!owner || !hasPlus(owner.tier)) return;

  // Entprellen: gleicher Hörer + gleicher Track in den letzten 30 Minuten → nichts.
  const since = new Date(Date.now() - 30 * 60 * 1000);
  const recent = await db.collection<Notification>("notifications").findOne({
    userId: track.owner,
    type: "listen",
    actorId: listener,
    trackId: track._id,
    createdAt: { $gt: since },
  });
  if (recent) return;

  let playlistName: string | undefined;
  if (track.playlistId) {
    const pl = await db
      .collection<Playlist>("playlists")
      .findOne({ _id: track.playlistId }, { projection: { name: 1 } });
    playlistName = pl?.name;
  }

  await createNotification({
    recipientId: track.owner,
    actorId: listener,
    type: "listen",
    trackId: track._id,
    trackTitle: track.title,
    playlistId: track.playlistId,
    playlistName,
  });
}

// Collaborator-Aktion → Owner + alle beigetretenen Mitglieder (außer dem Actor).
// Unabhängig von der Abo-Stufe des Empfängers (Collaboration-Feature).
export async function notifyCollabActivity(
  playlist: Pick<Playlist, "_id" | "name" | "owner" | "collaborators">,
  actorId: string,
  type: NotificationType,
  extra?: {
    trackId?: ObjectId;
    trackTitle?: string;
    meta?: NotificationMeta;
  }
) {
  if (!ObjectId.isValid(actorId)) return;
  const actor = new ObjectId(actorId);

  const joined = (playlist.collaborators ?? [])
    .map((c) => c.userId)
    .filter((id): id is ObjectId => !!id);
  const recipients = [playlist.owner, ...joined];

  const seen = new Set<string>();
  for (const r of recipients) {
    const key = r.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    if (r.equals(actor)) continue;
    await createNotification({
      recipientId: r,
      actorId: actor,
      type,
      playlistId: playlist._id,
      playlistName: playlist.name,
      trackId: extra?.trackId,
      trackTitle: extra?.trackTitle,
      meta: extra?.meta,
    });
  }
}

/** Jemand hat deinen geteilten Track / deine Playlist zur Mediathek hinzugefügt. */
export async function notifyShareSaved(
  ownerId: ObjectId,
  actorId: string,
  savedKind: "track" | "playlist",
  name: string,
  ids: { playlistId?: ObjectId; trackId?: ObjectId }
) {
  if (!ObjectId.isValid(actorId)) return;
  await createNotification({
    recipientId: ownerId,
    actorId: new ObjectId(actorId),
    type: "share_saved",
    playlistId: ids.playlistId,
    trackId: ids.trackId,
    trackTitle: savedKind === "track" ? name : undefined,
    playlistName: savedKind === "playlist" ? name : undefined,
    meta: { savedKind },
  });
}
