import { ObjectId } from "mongodb";

export interface SavedShare {
  _id?: ObjectId;
  userId: ObjectId;
  type: "audio" | "project";
  token: string; // shareToken bzw. projectShareToken
  createdAt: Date;
}
