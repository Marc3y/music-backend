import { Readable } from "stream";
import { parseStream } from "music-metadata";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { s3, BUCKET_NAME } from "../config/minio";
import { getDB } from "../config/db";
import { AudioFile } from "../models/AudioFile";
import { ObjectId } from "mongodb";

export async function processAudioMetadata(audioFileId: ObjectId, key: string) {
    const db = getDB();
    const audioFiles = db.collection<AudioFile>("audioFiles");
  
    try {
      const command = new GetObjectCommand({ Bucket: BUCKET_NAME, Key: key });
      const response = await s3.send(command);
  
      if (!response.Body) throw new Error("Kein Datei-Body erhalten");
  
      const nodeStream = response.Body as unknown as Readable;
  
      const metadata = await parseStream(nodeStream, undefined, {
        duration: true,
      });

    const duration = metadata.format.duration ? Math.round(metadata.format.duration) : undefined;
    const embeddedTitle = metadata.common.title;
    const embeddedArtist = metadata.common.artist;

    const updateFields: Partial<AudioFile> = {
      status: "ready",
      updatedAt: new Date(),
    };
    if (duration) updateFields.duration = duration;

    // Eingebettete Tags nur als Vorschlag nutzen, falls User noch nichts eigenes gesetzt hat
    const existing = await audioFiles.findOne({ _id: audioFileId });
    if (existing && embeddedTitle && existing.title === existing.originalFilename.replace(/\.[^/.]+$/, "")) {
      updateFields.title = embeddedTitle;
    }
    if (existing && embeddedArtist && !existing.artist) {
      updateFields.artist = embeddedArtist;
    }

    await audioFiles.updateOne({ _id: audioFileId }, { $set: updateFields });
    console.log(`✅ Metadaten verarbeitet für ${audioFileId}`);
  } catch (error) {
    console.error(`❌ Fehler bei Metadaten-Verarbeitung für ${audioFileId}:`, error);
    await audioFiles.updateOne(
      { _id: audioFileId },
      { $set: { status: "failed", updatedAt: new Date() } }
    );
  }
}