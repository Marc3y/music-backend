import { ObjectId } from "mongodb";

export interface TrackVersion {
  _id: ObjectId;
  label: string;               // Standard: originalFilename
  key: string;                 // MinIO Object Key der Audiodatei
  originalFilename: string;
  fileSize: number;
  mimeType: string;
  duration?: number;           // Sekunden, nach Verarbeitung
  bpm?: number | null;
  musicalKey?: string | null;
  projectKey?: string;         // optionale Projektdatei (.zip/.rar)
  projectFilename?: string;
  projectSize?: number;
  status: "processing" | "ready" | "failed";
  createdAt: Date;
}

export interface AudioFile {
  _id?: ObjectId;
  playlistId: ObjectId;
  owner: ObjectId;
  coverKey?: string;           // optionales eigenes Cover
  title: string;
  artist?: string;
  description?: string;
  order?: number;
  shareEnabled: boolean;
  shareToken?: string;
  shareProject?: boolean;      // Projektdatei der Hauptversion mitteilen?
  createdAt: Date;
  updatedAt: Date;

  versions: TrackVersion[];
  selectedVersionId: ObjectId; // "Hauptversion"

  // --- Mirror der Hauptversion (damit Listen/Player/Streaming unverändert laufen) ---
  key: string;
  originalFilename: string;
  fileSize: number;
  mimeType: string;
  duration?: number;
  bpm?: number | null;
  musicalKey?: string | null;
  status: "processing" | "ready" | "failed";
}
