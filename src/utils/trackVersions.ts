import { Collection, ObjectId } from "mongodb";
import { AudioFile, TrackVersion } from "../models/AudioFile";

export function buildVersion(
  key: string,
  originalFilename: string,
  fileSize: number,
  mimeType: string
): TrackVersion {
  return {
    _id: new ObjectId(),
    label: originalFilename,
    key,
    originalFilename,
    fileSize,
    mimeType,
    bpm: null,
    musicalKey: null,
    status: "processing",
    createdAt: new Date(),
  };
}

export function buildProjectVersion(
  projectKey: string,
  filename: string,
  projectSize: number
): TrackVersion {
  return {
    _id: new ObjectId(),
    label: filename,
    projectKey,
    projectFilename: filename,
    projectSize,
    bpm: null,
    musicalKey: null,
    status: "ready",
    createdAt: new Date(),
  };
}

export function findSelectedVersion(track: AudioFile): TrackVersion | undefined {
  return (
    track.versions.find((v) => v._id.equals(track.selectedVersionId)) ??
    track.versions[track.versions.length - 1]
  );
}

// Update-Doc, damit die Top-Level-"Mirror"-Felder die Hauptversion widerspiegeln.
// Fehlende Audio-Felder (reine Projekt-Einträge) werden per $unset entfernt.
export function mirrorUpdate(track: AudioFile): {
  $set: Partial<AudioFile>;
  $unset?: Record<string, "">;
} {
  const v = findSelectedVersion(track);
  if (!v) return { $set: {} };

  const $set: Partial<AudioFile> = {
    bpm: v.bpm ?? null,
    musicalKey: v.musicalKey ?? null,
    status: v.status,
  };
  const $unset: Record<string, ""> = {};

  for (const f of ["key", "originalFilename", "fileSize", "mimeType", "duration"] as const) {
    if (v[f] === undefined || v[f] === null) $unset[f] = "";
    else ($set as Record<string, unknown>)[f] = v[f];
  }

  return Object.keys($unset).length ? { $set, $unset } : { $set };
}

// Track neu laden und die Mirror-Felder aus der Hauptversion schreiben
export async function writeMirror(
  audioFiles: Collection<AudioFile>,
  trackId: ObjectId
) {
  const track = await audioFiles.findOne({ _id: trackId });
  if (!track) return;
  const m = mirrorUpdate(track);
  const update: Record<string, unknown> = {
    $set: { ...m.$set, updatedAt: new Date() },
  };
  if (m.$unset) update.$unset = m.$unset;
  await audioFiles.updateOne({ _id: trackId }, update);
}
