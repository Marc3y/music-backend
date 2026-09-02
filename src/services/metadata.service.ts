import { Readable } from "stream";
import { parseStream } from "music-metadata";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { s3, BUCKET_NAME } from "../config/minio";
import { getDB } from "../config/db";
import { AudioFile } from "../models/AudioFile";
import { ObjectId } from "mongodb";
import { mirrorFromSelected } from "../utils/trackVersions";

async function refreshMirror(trackId: ObjectId) {
  const audioFiles = getDB().collection<AudioFile>("audioFiles");
  const track = await audioFiles.findOne({ _id: trackId });
  if (!track) return;
  await audioFiles.updateOne(
    { _id: trackId },
    { $set: { ...mirrorFromSelected(track), updatedAt: new Date() } }
  );
}

export async function processAudioMetadata(
  trackId: ObjectId,
  versionId: ObjectId,
  key: string
) {
  const db = getDB();
  const audioFiles = db.collection<AudioFile>("audioFiles");

  try {
    const command = new GetObjectCommand({ Bucket: BUCKET_NAME, Key: key });
    const response = await s3.send(command);
    if (!response.Body) throw new Error("Kein Datei-Body erhalten");

    const nodeStream = response.Body as unknown as Readable;
    const metadata = await parseStream(nodeStream, undefined, { duration: true });

    const duration = metadata.format.duration
      ? Math.round(metadata.format.duration)
      : undefined;
    const embeddedTitle = metadata.common.title;
    const embeddedArtist = metadata.common.artist;
    const embeddedBpm =
      typeof metadata.common.bpm === "number" ? Math.round(metadata.common.bpm) : undefined;
    const embeddedKey = Array.isArray(metadata.common.key)
      ? metadata.common.key[0]
      : (metadata.common.key as string | undefined);

    const track = await audioFiles.findOne({ _id: trackId });
    if (!track) return;
    const version = track.versions.find((v) => v._id.equals(versionId));
    if (!version) return;

    const versionSet: Record<string, unknown> = {
      "versions.$.status": "ready",
    };
    if (duration) versionSet["versions.$.duration"] = duration;
    // Eingebettete BPM/Key nur als Fallback (Client-Analyse hat Vorrang)
    if (embeddedBpm && (version.bpm === null || version.bpm === undefined)) {
      versionSet["versions.$.bpm"] = embeddedBpm;
    }
    if (embeddedKey && (version.musicalKey === null || version.musicalKey === undefined)) {
      versionSet["versions.$.musicalKey"] = embeddedKey;
    }

    await audioFiles.updateOne(
      { _id: trackId, "versions._id": versionId },
      { $set: versionSet }
    );

    // Eingebettete Tags nur für die allererste Version als Track-Titel/Artist-Vorschlag
    const isFirstVersion = track.versions[0]?._id.equals(versionId);
    if (isFirstVersion) {
      const trackSet: Record<string, unknown> = {};
      if (
        embeddedTitle &&
        track.title === track.originalFilename.replace(/\.[^/.]+$/, "")
      ) {
        trackSet.title = embeddedTitle;
      }
      if (embeddedArtist && !track.artist) {
        trackSet.artist = embeddedArtist;
      }
      if (Object.keys(trackSet).length > 0) {
        await audioFiles.updateOne({ _id: trackId }, { $set: trackSet });
      }
    }

    await refreshMirror(trackId);
    console.log(`✅ Metadaten verarbeitet für ${trackId} / Version ${versionId}`);
  } catch (error) {
    console.error(`❌ Fehler bei Metadaten-Verarbeitung für ${trackId}:`, error);
    await audioFiles.updateOne(
      { _id: trackId, "versions._id": versionId },
      { $set: { "versions.$.status": "failed" } }
    );
    await refreshMirror(trackId);
  }
}
