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
  order?: number; // Sortierung in der Mediathek (aufsteigend)
  createdAt: Date;
  updatedAt: Date;

  // --- Read-only teilen ---
  shareEnabled?: boolean;
  shareToken?: string;
  shareRestricted?: boolean; // true = nur allowedUsernames
  shareAllowDownload?: boolean;
  allowedUsernames?: string[]; // lowercase
  /** bcrypt-Hash; wenn gesetzt, muss ein Passwort eingegeben werden (music+). */
  sharePasswordHash?: string;

  // --- Collaboration ---
  collabToken?: string;
  collaborators?: PlaylistCollaborator[];
}
