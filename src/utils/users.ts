import { ObjectId } from "mongodb";
import { getDB } from "../config/db";
import { User } from "../models/User";

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Case-insensitive exact-match filter for a string field. */
export function ciExact(value: string) {
  return { $regex: `^${escapeRegExp(value)}$`, $options: "i" as const };
}

/** Ist der Username (case-insensitiv) schon vergeben? `exceptId` schließt den eigenen User aus. */
export async function usernameTaken(
  username: string,
  exceptId?: ObjectId
): Promise<boolean> {
  const users = getDB().collection<User>("users");
  const existing = await users.findOne({
    username: { $regex: `^${escapeRegExp(username)}$`, $options: "i" },
    ...(exceptId ? { _id: { $ne: exceptId } } : {}),
  });
  return !!existing;
}
