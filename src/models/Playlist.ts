import { ObjectId } from "mongodb";

export interface PlaylistCollaborator {
  username: string;
  userId?: ObjectId;
}

export interface Playlist {
  _id?: ObjectId;
  name: string;
  coverKey?: string;
  owner: ObjectId;
  order?: number;
  createdAt: Date;
  updatedAt: Date;

  shareEnabled?: boolean;
  shareToken?: string;
  shareRestricted?: boolean;
  shareAllowDownload?: boolean;
  allowedUsernames?: string[];

  sharePasswordHash?: string;

  collabToken?: string;
  collaborators?: PlaylistCollaborator[];
}
