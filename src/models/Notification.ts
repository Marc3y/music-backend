import { ObjectId } from "mongodb";

export type NotificationType =
  | "listen"
  | "share_saved"
  | "collab_renamed"
  | "collab_cover"
  | "collab_track_added"
  | "collab_track_removed"
  | "collab_track_edited"
  | "collab_track_cover"
  | "collab_version_added"
  | "collab_version_removed"
  | "collab_version_selected"
  | "collab_reordered"
  | "collab_joined";

export interface NotificationMeta {
  field?: string;
  from?: string | null;
  to?: string | null;

  savedKind?: string;
}

export interface Notification {
  _id?: ObjectId;

  userId: ObjectId;
  type: NotificationType;

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
