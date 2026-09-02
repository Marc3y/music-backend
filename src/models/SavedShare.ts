import { ObjectId } from "mongodb";

export interface SavedShare {
  _id?: ObjectId;
  userId: ObjectId;
  type: "audio" | "project" | "playlist" | "collab";
  token: string; // shareToken / projectShareToken / playlist shareToken / collabToken
  createdAt: Date;
}
