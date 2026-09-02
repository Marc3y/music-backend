import { ObjectId } from "mongodb";
import { getDB } from "../config/db";
import { User } from "../models/User";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
