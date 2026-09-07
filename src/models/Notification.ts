import { ObjectId } from "mongodb";

export type NotificationType =
  | "listen" // jemand hat einen deiner Tracks gehört (nur music+)
  | "collab_renamed" // Collaborator hat die Playlist umbenannt
  | "collab_cover" // Collaborator hat das Playlist-Cover geändert
  | "collab_track_added" // Collaborator hat einen Track hochgeladen
  | "collab_track_removed" // Collaborator hat einen Track gelöscht
  | "collab_version_added" // Collaborator hat eine neue Version hochgeladen
  | "collab_joined"; // jemand ist der Playlist als Mitglied beigetreten

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
  createdAt: Date;
  readAt?: Date | null;
}
