import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import { ObjectId } from "mongodb";
import { connectDB, getDB } from "./config/db";
import { DEFAULT_STORAGE_LIMIT_BYTES } from "./config/limits";
import { AudioFile } from "./models/AudioFile";
import { normalizeKey } from "./utils/musicalKey";
import authRoutes from "./routes/auth.routes";
import accountRoutes from "./routes/account.routes";
import playlistsRoutes from "./routes/playlists.routes";
import audioFilesRoutes from "./routes/audioFiles.routes";
import notificationsRoutes from "./routes/notifications.routes";
import { errorHandler } from "./middleware/errorHandler";

const app = express();
const PORT = process.env.PORT || 3000;

// Behind a reverse proxy (nginx). Trust the first hop so req.ip and
// express-rate-limit use the real client IP from X-Forwarded-For.
app.set("trust proxy", 1);

app.use(express.json());
app.use(cookieParser());
app.use(cors({ origin: process.env.FRONTEND_URL, credentials: true })); // Frontend-URL später anpassen

app.use("/auth", authRoutes);
app.use("/account", accountRoutes);
app.use("/playlists", playlistsRoutes);
app.use("/audio-files", audioFilesRoutes);
app.use("/notifications", notificationsRoutes);
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

async function startServer() {
  try {
    await connectDB();

    // Bestandsuser bekommen das Standard-Speicherlimit als Feld (idempotent)
    await getDB()
      .collection("users")
      .updateMany(
        { storageLimit: { $exists: false } },
        { $set: { storageLimit: DEFAULT_STORAGE_LIMIT_BYTES } }
      );

    // Abo-Stufe: alle ohne Feld auf "free" (idempotent)
    await getDB()
      .collection("users")
      .updateMany({ tier: { $exists: false } }, { $set: { tier: "free" } });

    // Bestandstracks in das Versions-Modell überführen (idempotent)
    const audioFiles = getDB().collection<AudioFile>("audioFiles");
    const legacy = audioFiles.find({ versions: { $exists: false } } as any);
    let migrated = 0;
    for await (const doc of legacy) {
      const d = doc as any;
      const versionId = new ObjectId();
      await audioFiles.updateOne(
        { _id: d._id },
        {
          $set: {
            versions: [
              {
                _id: versionId,
                label: "Version 1",
                key: d.key,
                originalFilename: d.originalFilename,
                fileSize: d.fileSize,
                mimeType: d.mimeType,
                duration: d.duration,
                bpm: null,
                musicalKey: null,
                status: d.status ?? "ready",
                createdAt: d.createdAt ?? new Date(),
              },
            ],
            selectedVersionId: versionId,
            shareProject: d.shareProject ?? false,
            kind: d.kind ?? "track",
            bpm: null,
            musicalKey: null,
          },
        }
      );
      migrated++;
    }
    if (migrated > 0) console.log(`🔀 ${migrated} Track(s) auf Versions-Modell migriert`);

    await audioFiles.updateMany(
      { kind: { $exists: false } },
      { $set: { kind: "track" } }
    );

    // Tonarten auf kompakte englische Notation umstellen ("F# moll" -> "F#m") – idempotent
    {
      const cursor = audioFiles.find({
        $or: [
          { musicalKey: { $regex: "(moll|dur)$", $options: "i" } },
          { "versions.musicalKey": { $regex: "(moll|dur)$", $options: "i" } },
        ],
      } as any);
      let keyMigrated = 0;
      for await (const doc of cursor) {
        const d = doc as any;
        const set: Record<string, unknown> = {};
        if (typeof d.musicalKey === "string") set.musicalKey = normalizeKey(d.musicalKey);
        (d.versions ?? []).forEach((v: any, i: number) => {
          if (typeof v.musicalKey === "string") {
            set[`versions.${i}.musicalKey`] = normalizeKey(v.musicalKey);
          }
        });
        if (Object.keys(set).length) {
          await audioFiles.updateOne({ _id: d._id }, { $set: set });
          keyMigrated++;
        }
      }
      if (keyMigrated > 0) console.log(`🎼 ${keyMigrated} Track(s) Tonart-Notation migriert`);
    }

    // Mediathek-Sortierung: bestehende Playlists / gespeicherte Shares mit `order` befüllen (idempotent)
    {
      const playlists = getDB().collection("playlists");
      const ownersCursor = playlists.aggregate([
        { $match: { order: { $exists: false } } },
        { $group: { _id: "$owner" } },
      ]);
      let plMigrated = 0;
      for await (const grp of ownersCursor) {
        const rows = await playlists
          .find({ owner: grp._id })
          .sort({ order: 1, createdAt: -1 })
          .project({ _id: 1 })
          .toArray();
        await playlists.bulkWrite(
          rows.map((r, i) => ({
            updateOne: { filter: { _id: r._id }, update: { $set: { order: i } } },
          }))
        );
        plMigrated += rows.length;
      }
      if (plMigrated > 0) console.log(`↕️  ${plMigrated} Playlist(s) Sortierung initialisiert`);

      const savedShares = getDB().collection("savedShares");
      const usersCursor = savedShares.aggregate([
        { $match: { order: { $exists: false } } },
        { $group: { _id: "$userId" } },
      ]);
      let ssMigrated = 0;
      for await (const grp of usersCursor) {
        const rows = await savedShares
          .find({ userId: grp._id })
          .sort({ order: 1, createdAt: -1 })
          .project({ _id: 1 })
          .toArray();
        await savedShares.bulkWrite(
          rows.map((r, i) => ({
            updateOne: { filter: { _id: r._id }, update: { $set: { order: i } } },
          }))
        );
        ssMigrated += rows.length;
      }
      if (ssMigrated > 0) console.log(`↕️  ${ssMigrated} gespeicherte Share(s) Sortierung initialisiert`);
    }

    // Indizes (best effort, einzeln – ein Konflikt darf die anderen nicht überspringen)
    const ensureIndex = async (
      coll: string,
      spec: Record<string, 1 | -1>,
      opts?: Record<string, unknown>
    ) => {
      try {
        await getDB().collection(coll).createIndex(spec as any, opts);
      } catch (err) {
        console.warn(
          `⚠️  Index ${coll} ${JSON.stringify(spec)} übersprungen:`,
          (err as Error).message
        );
      }
    };
    await ensureIndex("users", { username: 1 });
    await ensureIndex("users", { googleId: 1 }, { sparse: true });
    await ensureIndex("savedShares", { userId: 1, type: 1, token: 1 }, { unique: true });
    await ensureIndex("playlists", { shareToken: 1 });
    await ensureIndex("playlists", { collabToken: 1 });
    await ensureIndex("playlists", { "collaborators.userId": 1 });
    await ensureIndex("notifications", { userId: 1, _id: -1 });
    await ensureIndex("notifications", { userId: 1, readAt: 1 });
    await ensureIndex("trackEvents", { ownerId: 1, type: 1, createdAt: -1 });
    await ensureIndex("trackEvents", { trackId: 1, type: 1 });
    await ensureIndex("trackEvents", { ownerId: 1, userId: 1, type: 1 });
    await ensureIndex(
      "notifications",
      { createdAt: 1 },
      { expireAfterSeconds: 60 * 60 * 24 * 60 } // 60 Tage aufheben
    );

    app.listen(PORT, () => {
      console.log(`🚀 Server läuft auf http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error("❌ Fehler beim Starten:", error);
    process.exit(1);
  }
}

startServer();

app.use(errorHandler);