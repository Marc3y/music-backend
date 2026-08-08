import { ObjectId } from "mongodb";

export interface Playlist {
  _id?: ObjectId;
  name: string;
  coverKey?: string;
  owner: ObjectId;
  createdAt: Date;
  updatedAt: Date;
}