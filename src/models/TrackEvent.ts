import { ObjectId } from "mongodb";

export type TrackEventType = "listen" | "download";

export interface TrackEvent {
  _id?: ObjectId;
  trackId: ObjectId;
  /** Owner of the track (denormalised for fast per-owner stats). */
  ownerId: ObjectId;
  /** Logged-in listener/downloader, or null for anonymous. */
  userId: ObjectId | null;
  type: TrackEventType;
  createdAt: Date;
}
