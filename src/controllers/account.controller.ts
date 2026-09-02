import { Response } from "express";
import bcrypt from "bcrypt";
import { ObjectId } from "mongodb";
import { getDB } from "../config/db";
import { User } from "../models/User";
import { Playlist } from "../models/Playlist";
import { AudioFile } from "../models/AudioFile";
import { AuthRequest } from "../middleware/auth.middleware";
import {
  updateUsernameSchema,
  changePasswordRequestSchema,
  codeConfirmSchema,
  deleteAccountRequestSchema,
  uploadUrlRequestSchema,
} from "../utils/validators";
import { generateSixDigitCode } from "../utils/tokens";
import {
  sendPasswordChangeCodeEmail,
  sendAccountDeletionCodeEmail,
} from "../services/email.service";
import {
  generateObjectKey,
  getUploadUrl,
  getDownloadUrl,
  deleteObject,
} from "../services/storage.service";

const CODE_TTL_MS = 15 * 60 * 1000;

function clearAuthCookies(res: Response) {
  res.clearCookie("accessToken");
  res.clearCookie("refreshToken");
}

// S3-Objekt löschen, ohne dass ein fehlendes Objekt den Ablauf abbricht
async function safeDeleteObject(key?: string) {
  if (!key) return;
  try {
    await deleteObject(key);
  } catch (err) {
    console.error(`⚠️  Objekt konnte nicht gelöscht werden (${key}):`, err);
  }
}

async function serializeUser(user: User) {
  return {
    id: user._id!.toString(),
    email: user.email,
    username: user.username,
    avatarUrl: user.avatarKey ? await getDownloadUrl(user.avatarKey) : null,
  };
}

export async function getMe(req: AuthRequest, res: Response) {
  const db = getDB();
  const users = db.collection<User>("users");

  const user = await users.findOne({ _id: new ObjectId(req.userId) });
  if (!user) {
    return res.status(404).json({ error: "User nicht gefunden" });
  }

  res.json(await serializeUser(user));
}

export async function updateUsername(req: AuthRequest, res: Response) {
  const parseResult = updateUsernameSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({ error: parseResult.error.issues[0].message });
  }

  const db = getDB();
  const users = db.collection<User>("users");

  const user = await users.findOneAndUpdate(
    { _id: new ObjectId(req.userId) },
    { $set: { username: parseResult.data.username } },
    { returnDocument: "after" }
  );

  if (!user) {
    return res.status(404).json({ error: "User nicht gefunden" });
  }

  res.json(await serializeUser(user));
}

export async function getAvatarUploadUrl(req: AuthRequest, res: Response) {
  const parseResult = uploadUrlRequestSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({ error: parseResult.error.issues[0].message });
  }

  const { filename, contentType } = parseResult.data;
  if (!contentType.startsWith("image/")) {
    return res.status(400).json({ error: "Nur Bilddateien erlaubt" });
  }

  const db = getDB();
  const users = db.collection<User>("users");

  const user = await users.findOne({ _id: new ObjectId(req.userId) });
  if (!user) {
    return res.status(404).json({ error: "User nicht gefunden" });
  }

  // Altes Avatar-Objekt aufräumen
  await safeDeleteObject(user.avatarKey);

  const key = generateObjectKey(`avatars/${req.userId}`, filename);
  const uploadUrl = await getUploadUrl(key, contentType);

  await users.updateOne({ _id: user._id }, { $set: { avatarKey: key } });

  res.json({ uploadUrl, key });
}

export async function deleteAvatar(req: AuthRequest, res: Response) {
  const db = getDB();
  const users = db.collection<User>("users");

  const user = await users.findOne({ _id: new ObjectId(req.userId) });
  if (!user) {
    return res.status(404).json({ error: "User nicht gefunden" });
  }

  await safeDeleteObject(user.avatarKey);
  await users.updateOne({ _id: user._id }, { $unset: { avatarKey: "" } });

  res.json({ message: "Profilbild entfernt" });
}

export async function requestPasswordChange(req: AuthRequest, res: Response) {
  const parseResult = changePasswordRequestSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({ error: parseResult.error.issues[0].message });
  }

  const { currentPassword, newPassword } = parseResult.data;
  const db = getDB();
  const users = db.collection<User>("users");

  const user = await users.findOne({ _id: new ObjectId(req.userId) });
  if (!user) {
    return res.status(404).json({ error: "User nicht gefunden" });
  }

  const matches = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!matches) {
    return res.status(401).json({ error: "Aktuelles Passwort falsch" });
  }

  const pendingPasswordHash = await bcrypt.hash(newPassword, 10);
  const code = generateSixDigitCode();

  await users.updateOne(
    { _id: user._id },
    {
      $set: {
        pendingPasswordHash,
        passwordChangeCode: code,
        passwordChangeExpiry: new Date(Date.now() + CODE_TTL_MS),
      },
    }
  );

  await sendPasswordChangeCodeEmail(user.email, code);

  res.json({ message: "Bestätigungscode an deine E-Mail gesendet" });
}

export async function confirmPasswordChange(req: AuthRequest, res: Response) {
  const parseResult = codeConfirmSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({ error: parseResult.error.issues[0].message });
  }

  const db = getDB();
  const users = db.collection<User>("users");

  const user = await users.findOne({ _id: new ObjectId(req.userId) });
  if (!user) {
    return res.status(404).json({ error: "User nicht gefunden" });
  }

  if (!user.pendingPasswordHash || !user.passwordChangeCode) {
    return res.status(400).json({ error: "Keine Passwortänderung angefordert" });
  }

  if (user.passwordChangeCode !== parseResult.data.code) {
    return res.status(400).json({ error: "Ungültiger Code" });
  }

  if (!user.passwordChangeExpiry || user.passwordChangeExpiry < new Date()) {
    return res.status(400).json({ error: "Code abgelaufen" });
  }

  await users.updateOne(
    { _id: user._id },
    {
      $set: { passwordHash: user.pendingPasswordHash },
      $unset: {
        pendingPasswordHash: "",
        passwordChangeCode: "",
        passwordChangeExpiry: "",
      },
    }
  );

  clearAuthCookies(res);
  res.json({ message: "Passwort geändert. Bitte melde dich neu an." });
}

export async function requestAccountDeletion(req: AuthRequest, res: Response) {
  const parseResult = deleteAccountRequestSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({ error: parseResult.error.issues[0].message });
  }

  const db = getDB();
  const users = db.collection<User>("users");

  const user = await users.findOne({ _id: new ObjectId(req.userId) });
  if (!user) {
    return res.status(404).json({ error: "User nicht gefunden" });
  }

  const matches = await bcrypt.compare(parseResult.data.password, user.passwordHash);
  if (!matches) {
    return res.status(401).json({ error: "Passwort falsch" });
  }

  const code = generateSixDigitCode();
  await users.updateOne(
    { _id: user._id },
    {
      $set: {
        accountDeletionCode: code,
        accountDeletionExpiry: new Date(Date.now() + CODE_TTL_MS),
      },
    }
  );

  await sendAccountDeletionCodeEmail(user.email, code);

  res.json({ message: "Bestätigungscode an deine E-Mail gesendet" });
}

// Alle Daten eines Users unwiderruflich entfernen (DB + Objektspeicher)
async function deleteAllUserData(userId: ObjectId, user: User) {
  const db = getDB();
  const playlists = db.collection<Playlist>("playlists");
  const audioFiles = db.collection<AudioFile>("audioFiles");
  const users = db.collection<User>("users");

  const tracks = await audioFiles.find({ owner: userId }).toArray();
  for (const track of tracks) {
    await safeDeleteObject(track.key);
    await safeDeleteObject(track.coverKey);
  }
  await audioFiles.deleteMany({ owner: userId });

  const userPlaylists = await playlists.find({ owner: userId }).toArray();
  for (const playlist of userPlaylists) {
    await safeDeleteObject(playlist.coverKey);
  }
  await playlists.deleteMany({ owner: userId });

  await safeDeleteObject(user.avatarKey);

  await users.deleteOne({ _id: userId });
}

export async function confirmAccountDeletion(req: AuthRequest, res: Response) {
  const parseResult = codeConfirmSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({ error: parseResult.error.issues[0].message });
  }

  const db = getDB();
  const users = db.collection<User>("users");

  const userId = new ObjectId(req.userId);
  const user = await users.findOne({ _id: userId });
  if (!user) {
    return res.status(404).json({ error: "User nicht gefunden" });
  }

  if (!user.accountDeletionCode) {
    return res.status(400).json({ error: "Keine Löschung angefordert" });
  }

  if (user.accountDeletionCode !== parseResult.data.code) {
    return res.status(400).json({ error: "Ungültiger Code" });
  }

  if (!user.accountDeletionExpiry || user.accountDeletionExpiry < new Date()) {
    return res.status(400).json({ error: "Code abgelaufen" });
  }

  await deleteAllUserData(userId, user);

  clearAuthCookies(res);
  res.json({ message: "Account gelöscht" });
}
