import { ObjectId } from "mongodb";

export interface SavedShare {
  _id?: ObjectId;
  userId: ObjectId;
  type: "audio" | "project" | "playlist" | "collab";
  token: string;
  order?: number;
  createdAt: Date;
}
