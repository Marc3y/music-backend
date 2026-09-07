import { Response } from "express";
import { ObjectId } from "mongodb";
import { getDB } from "../config/db";
import { AuthRequest } from "../middleware/auth.middleware";
import { Notification } from "../models/Notification";
import {
  addSseClient,
  removeSseClient,
  serializeNotification,
} from "../services/notifications.service";

export async function listNotifications(req: AuthRequest, res: Response) {
  const db = getDB();
  const userId = new ObjectId(req.userId);

  const limit = Math.min(Math.max(Number(req.query.limit) || 40, 1), 100);
  const before =
    typeof req.query.before === "string" && ObjectId.isValid(req.query.before)
      ? new ObjectId(req.query.before)
      : null;

  const q: Record<string, unknown> = { userId };
  if (before) q._id = { $lt: before };

  const docs = await db
    .collection<Notification>("notifications")
    .find(q)
    .sort({ _id: -1 })
    .limit(limit)
    .toArray();

  const unreadCount = await db
    .collection<Notification>("notifications")
    .countDocuments({ userId, readAt: null });

  res.json({
    notifications: await Promise.all(docs.map(serializeNotification)),
    unreadCount,
    nextCursor:
      docs.length === limit ? docs[docs.length - 1]._id!.toString() : null,
  });
}

export async function markNotificationsRead(req: AuthRequest, res: Response) {
  const db = getDB();
  const userId = new ObjectId(req.userId);

  const ids = Array.isArray(req.body?.ids)
    ? (req.body.ids as unknown[]).filter(
        (id): id is string => typeof id === "string" && ObjectId.isValid(id)
      )
    : null;

  const filter: Record<string, unknown> = { userId, readAt: null };
  if (ids && ids.length) filter._id = { $in: ids.map((id) => new ObjectId(id)) };

  await db
    .collection<Notification>("notifications")
    .updateMany(filter, { $set: { readAt: new Date() } });

  res.json({ ok: true });
}

export function streamNotifications(req: AuthRequest, res: Response) {
  res.set({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  (res as Response & { flushHeaders?: () => void }).flushHeaders?.();
  res.write(": connected\n\n");

  const uid = req.userId!;
  addSseClient(uid, res);

  const ping = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {
      /* ignore */
    }
  }, 25000);

  req.on("close", () => {
    clearInterval(ping);
    removeSseClient(uid, res);
  });
}
