import { ObjectId } from "mongodb";

export type NotificationType =
  | "listen" // jemand hat einen deiner Tracks gehört (nur music+)
  | "share_saved" // jemand hat deinen geteilten Track/deine Playlist zur Mediathek hinzugefügt
  | "collab_renamed" // Collaborator hat die Playlist umbenannt
  | "collab_cover" // Collaborator hat das Playlist-Cover geändert
  | "collab_track_added" // Collaborator hat einen Track hochgeladen
  | "collab_track_removed" // Collaborator hat einen Track gelöscht
  | "collab_track_edited" // Titel / Interpret / Beschreibung / BPM / Key geändert
  | "collab_track_cover" // Track-Cover geändert
  | "collab_version_added" // neue Version / Projektdatei hochgeladen
  | "collab_version_removed" // Version / Projektdatei gelöscht
  | "collab_version_selected" // andere Hauptversion gewählt
  | "collab_reordered" // Reihenfolge geändert
  | "collab_joined"; // jemand ist der Playlist als Mitglied beigetreten

/** Optionale Detail-Angaben, z.B. "hat X von A auf B geändert". */
export interface NotificationMeta {
  field?: string; // z.B. "title", "artist", "bpm", "key", "name", "description"
  from?: string | null;
  to?: string | null;
  /** z.B. "track" oder "playlist" — was für ein geteilter Link gespeichert wurde */
  savedKind?: string;
}

export interface Notification {
  _id?: ObjectId;
  /** Empfänger */
  userId: ObjectId;
  type: NotificationType;
  /** Wer die Aktion ausgelöst hat */
  actorId: ObjectId;
  actorUsername: string;
  actorAvatarKey?: string | null;
  playlistId?: ObjectId;
  playlistName?: string;
  trackId?: ObjectId;
  trackTitle?: string;
  meta?: NotificationMeta;
  createdAt: Date;
  readAt?: Date | null;
}
