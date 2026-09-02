import { ObjectId } from "mongodb";
import { getDB } from "../config/db";
import { Playlist } from "../models/Playlist";
import { User } from "../models/User";

export function isOwner(pl: Playlist, userId?: string): boolean {
  return !!userId && pl.owner.equals(userId);
}

export function isCollaborator(pl: Playlist, userId?: string): boolean {
  if (!userId) return false;
  return (pl.collaborators ?? []).some((c) => c.userId && c.userId.equals(userId));
}

export function canEdit(pl: Playlist, userId?: string): boolean {
  return isOwner(pl, userId) || isCollaborator(pl, userId);
}

// Playlist zurückgeben, wenn der User sie bearbeiten darf (Owner oder beigetretenes Mitglied)
export async function getEditablePlaylist(
  playlistId: string,
  userId: string
): Promise<Playlist | null> {
  if (!ObjectId.isValid(playlistId)) return null;
  const uid = new ObjectId(userId);
  return getDB()
    .collection<Playlist>("playlists")
    .findOne({
      _id: new ObjectId(playlistId),
      $or: [{ owner: uid }, { "collaborators.userId": uid }],
    });
}

export async function getUsernameLower(userId: string): Promise<string | null> {
  const user = await getDB()
    .collection<User>("users")
    .findOne({ _id: new ObjectId(userId) }, { projection: { username: 1 } });
  return user ? user.username.toLowerCase() : null;
}

// Kann der (optional eingeloggte) Betrachter die geteilte Playlist ansehen?
export async function canViewShared(
  pl: Playlist,
  userId?: string
): Promise<{ ok: boolean; needsLogin?: boolean }> {
  if (!pl.shareEnabled) return { ok: false };
  if (!pl.shareRestricted) return { ok: true };
  if (!userId) return { ok: false, needsLogin: true };
  if (isOwner(pl, userId) || isCollaborator(pl, userId)) return { ok: true };
  const uname = await getUsernameLower(userId);
  return { ok: !!uname && (pl.allowedUsernames ?? []).includes(uname) };
}
