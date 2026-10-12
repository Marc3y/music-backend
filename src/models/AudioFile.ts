import { ObjectId } from "mongodb";

export interface TrackVersion {
  _id: ObjectId;
  label: string;
  key?: string;
  originalFilename?: string;
  fileSize?: number;
  mimeType?: string;
  duration?: number;
  bpm?: number | null;
  musicalKey?: string | null;
  projectKey?: string;
  projectFilename?: string;
  projectSize?: number;
  status: "processing" | "ready" | "failed";
  createdAt: Date;
}

export interface AudioFile {
  _id?: ObjectId;
  playlistId: ObjectId;
  owner: ObjectId;
  kind?: "track" | "project";
  coverKey?: string;
  title: string;
  artist?: string;
  description?: string;
  order?: number;
  shareEnabled: boolean;
  shareToken?: string;
  shareProject?: boolean;
  projectShareEnabled?: boolean;
  projectShareToken?: string;

  sharePasswordHash?: string;
  createdAt: Date;
  updatedAt: Date;

  versions: TrackVersion[];
  selectedVersionId: ObjectId;

  key?: string;
  originalFilename?: string;
  fileSize?: number;
  mimeType?: string;
  duration?: number;
  bpm?: number | null;
  musicalKey?: string | null;
  status: "processing" | "ready" | "failed";
}
