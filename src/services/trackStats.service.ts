import { ObjectId } from "mongodb";
import { getDB } from "../config/db";
import { TrackEvent, TrackEventType } from "../models/TrackEvent";
import { AudioFile } from "../models/AudioFile";
import { getDownloadUrl } from "./storage.service";

function events() {
  return getDB().collection<TrackEvent>("trackEvents");
}

/** Record one play (already past the 15s threshold) or download. */
export async function logTrackEvent(
  trackId: ObjectId,
  ownerId: ObjectId,
  userId: string | undefined,
  type: TrackEventType
) {
  await events().insertOne({
    trackId,
    ownerId,
    userId: userId && ObjectId.isValid(userId) ? new ObjectId(userId) : null,
    type,
    createdAt: new Date(),
  });
}

/** Per-track counters, used by the info dialog. */
export async function trackCounts(trackId: ObjectId) {
  const rows = await events()
    .aggregate<{ _id: TrackEventType; count: number; users: number }>([
      { $match: { trackId } },
      {
        $group: {
          _id: "$type",
          count: { $sum: 1 },
          uniqueUsers: { $addToSet: "$userId" },
        },
      },
      { $project: { count: 1, users: { $size: "$uniqueUsers" } } },
    ])
    .toArray();
  const listen = rows.find((r) => r._id === "listen");
  const download = rows.find((r) => r._id === "download");
  return {
    listens: listen?.count ?? 0,
    listeners: listen?.users ?? 0,
    downloads: download?.count ?? 0,
  };
}

/** Full stats bundle for the account stats page. */
export async function ownerStats(ownerId: ObjectId) {
  const db = getDB();
  const audioFiles = db.collection<AudioFile>("audioFiles");

  const [byType, topTracksRaw, topListenersRaw, perDay] = await Promise.all([
    events()
      .aggregate<{ _id: TrackEventType; count: number; users: string[] }>([
        { $match: { ownerId } },
        { $group: { _id: "$type", count: { $sum: 1 }, users: { $addToSet: "$userId" } } },
      ])
      .toArray(),

    events()
      .aggregate<{ _id: ObjectId; listens: number; downloads: number }>([
        { $match: { ownerId } },
        {
          $group: {
            _id: "$trackId",
            listens: { $sum: { $cond: [{ $eq: ["$type", "listen"] }, 1, 0] } },
            downloads: { $sum: { $cond: [{ $eq: ["$type", "download"] }, 1, 0] } },
          },
        },
        { $sort: { listens: -1, downloads: -1 } },
        { $limit: 20 },
      ])
      .toArray(),

    events()
      .aggregate<{ _id: ObjectId | null; listens: number }>([
        { $match: { ownerId, type: "listen", userId: { $ne: null } } },
        { $group: { _id: "$userId", listens: { $sum: 1 } } },
        { $sort: { listens: -1 } },
        { $limit: 8 },
      ])
      .toArray(),

    events()
      .aggregate<{ _id: string; listens: number }>([
        {
          $match: {
            ownerId,
            type: "listen",
            createdAt: { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
          },
        },
        {
          $group: {
            _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
            listens: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ])
      .toArray(),
  ]);

  const listenAgg = byType.find((r) => r._id === "listen");
  const downloadAgg = byType.find((r) => r._id === "download");

  const trackIds = topTracksRaw.map((t) => t._id);
  const trackDocs = await audioFiles
    .find({ _id: { $in: trackIds } }, { projection: { title: 1, coverKey: 1, artist: 1 } })
    .toArray();
  const trackById = new Map(trackDocs.map((t) => [t._id!.toString(), t]));

  const listenerIds = topListenersRaw.map((l) => l._id!).filter(Boolean) as ObjectId[];
  const listenerDocs = await db
    .collection("users")
    .find(
      { _id: { $in: listenerIds } },
      { projection: { username: 1, avatarKey: 1 } }
    )
    .toArray();
  const userById = new Map(listenerDocs.map((u) => [u._id!.toString(), u]));

  const topTracks = await Promise.all(
    topTracksRaw.map(async (t) => {
      const doc = trackById.get(t._id.toString());
      return {
        trackId: t._id.toString(),
        title: doc?.title ?? "—",
        artist: doc?.artist ?? null,
        coverUrl: doc?.coverKey ? await getDownloadUrl(doc.coverKey) : null,
        listens: t.listens,
        downloads: t.downloads,
      };
    })
  );

  const topListeners = await Promise.all(
    topListenersRaw.map(async (l) => {
      const doc = l._id ? userById.get(l._id.toString()) : null;
      return {
        username: doc?.username ?? "—",
        avatarUrl: doc?.avatarKey ? await getDownloadUrl(doc.avatarKey) : null,
        listens: l.listens,
      };
    })
  );

  return {
    totals: {
      listens: listenAgg?.count ?? 0,
      downloads: downloadAgg?.count ?? 0,
      uniqueListeners:
        (listenAgg?.users ?? []).filter((u) => u !== null).length ?? 0,
      trackCount: await audioFiles.countDocuments({ owner: ownerId }),
    },
    topTracks,
    topDownloaded: [...topTracks]
      .filter((t) => t.downloads > 0)
      .sort((a, b) => b.downloads - a.downloads)
      .slice(0, 10),
    topListeners,
    perDay,
  };
}
