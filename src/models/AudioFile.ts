import { ObjectId } from "mongodb";

export interface AudioFile {
  _id?: ObjectId;
  playlistId: ObjectId;
  owner: ObjectId;
  key: string;                 // MinIO Object Key der Audiodatei
  coverKey?: string;           // optionales eigenes Cover
  originalFilename: string;
  title: string;
  artist?: string;
  description?: string;
  duration?: number;           // in Sekunden, wird nach Verarbeitung gesetzt
  fileSize: number;
  mimeType: string;
  status: "processing" | "ready" | "failed";
  shareEnabled: boolean;
  shareToken?: string;
  createdAt: Date;
  updatedAt: Date;
}