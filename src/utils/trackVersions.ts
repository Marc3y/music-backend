import { ObjectId } from "mongodb";
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

export function findSelectedVersion(track: AudioFile): TrackVersion | undefined {
  return (
    track.versions.find((v) => v._id.equals(track.selectedVersionId)) ??
    track.versions[track.versions.length - 1]
  );
}

// $set-Felder, damit die Top-Level-"Mirror"-Felder die Hauptversion widerspiegeln
export function mirrorFromSelected(track: AudioFile): Partial<AudioFile> {
  const v = findSelectedVersion(track);
  if (!v) return {};
  const set: Partial<AudioFile> = {
    key: v.key,
    originalFilename: v.originalFilename,
    fileSize: v.fileSize,
    mimeType: v.mimeType,
    bpm: v.bpm ?? null,
    musicalKey: v.musicalKey ?? null,
    status: v.status,
  };
  if (typeof v.duration === "number") set.duration = v.duration;
  return set;
}
