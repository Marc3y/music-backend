import { ObjectId } from "mongodb";

export interface PlaylistCollaborator {
  username: string; // lowercase
  userId?: ObjectId; // gesetzt, sobald der User über den Invite-Link beigetreten ist
}

export interface Playlist {
  _id?: ObjectId;
  name: string;
  coverKey?: string;
  owner: ObjectId;
  createdAt: Date;
  updatedAt: Date;

  // --- Read-only teilen ---
  shareEnabled?: boolean;
  shareToken?: string;
  shareRestricted?: boolean; // true = nur allowedUsernames
  shareAllowDownload?: boolean;
  allowedUsernames?: string[]; // lowercase

  // --- Collaboration ---
  collabToken?: string;
  collaborators?: PlaylistCollaborator[];
}
