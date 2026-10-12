import { ObjectId } from "mongodb";

export type TrackEventType = "listen" | "download";

export interface TrackEvent {
  _id?: ObjectId;
  trackId: ObjectId;

  ownerId: ObjectId;

  userId: ObjectId | null;
  type: TrackEventType;
  createdAt: Date;
}
