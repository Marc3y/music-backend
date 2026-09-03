import { Request, Response } from "express";
import bcrypt from "bcrypt";
import { randomBytes } from "crypto";
import { sendPasswordResetEmail } from "../services/email.service";
import { forgotPasswordSchema, resetPasswordSchema } from "../utils/validators";
import { getDB } from "../config/db";
import { User } from "../models/User";
import { registerSchema, loginSchema, verifyEmailSchema } from "../utils/validators";
import { sendVerificationEmail } from "../services/email.service";
import { generateAccessToken, generateRefreshToken, generateSixDigitCode } from "../utils/tokens";
import { DEFAULT_STORAGE_LIMIT_BYTES } from "../config/limits";
import { usernameTaken, ciExact } from "../utils/users";
import { verifyRefreshToken } from "../utils/tokens";
import { verifySupabaseToken } from "../utils/supabase";
import { updateUsernameSchema } from "../utils/validators";
import { ObjectId } from "mongodb";

/** Sets the access/refresh token cookies for a user id. */
function issueSession(res: Response, userId: string) {
  const accessToken = generateAccessToken(userId);
  const refreshToken = generateRefreshToken(userId);

  res.cookie("accessToken", accessToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 15 * 60 * 1000,
  });

  res.cookie("refreshToken", refreshToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
}

function publicUser(user: User) {
  return {
    id: user._id!.toString(),
    email: user.email,
    username: user.username,
    hasPassword: !!user.passwordHash,
  };
}

export async function register(req: Request, res: Response) {
  const parseResult = registerSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({ error: parseResult.error.issues[0].message });
  }

  const { email, username, password } = parseResult.data;
  const db = getDB();
  const users = db.collection<User>("users");

  const existingUser = await users.findOne({ email });
  if (existingUser) {
    return res.status(409).json({ error: "E-Mail wird bereits verwendet" });
  }

  if (await usernameTaken(username)) {
    return res.status(409).json({ error: "Dieser Username ist bereits vergeben" });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const verificationCode = generateSixDigitCode();

  const newUser: User = {
    email,
    username,
    passwordHash,
    emailVerified: false,
    emailVerificationCode: verificationCode,
    emailVerificationExpiry: new Date(Date.now() + 15 * 60 * 1000), // 15 Min
    storageLimit: DEFAULT_STORAGE_LIMIT_BYTES,
    createdAt: new Date(),
  };

  await users.insertOne(newUser);
  await sendVerificationEmail(email, verificationCode);

  res.status(201).json({ message: "Registrierung erfolgreich. Bitte E-Mail bestätigen." });
}

export async function verifyEmail(req: Request, res: Response) {
  const parseResult = verifyEmailSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({ error: parseResult.error.issues[0].message });
  }

  const { email, code } = parseResult.data;
  const db = getDB();
  const users = db.collection<User>("users");

  const user = await users.findOne({ email });
  if (!user) {
    return res.status(404).json({ error: "User nicht gefunden" });
  }

  if (user.emailVerified) {
    return res.status(400).json({ error: "E-Mail bereits verifiziert" });
  }

  if (user.emailVerificationCode !== code) {
    return res.status(400).json({ error: "Ungültiger Code" });
  }

  if (!user.emailVerificationExpiry || user.emailVerificationExpiry < new Date()) {
    return res.status(400).json({ error: "Code abgelaufen" });
  }

  await users.updateOne(
    { email },
    {
      $set: { emailVerified: true },
      $unset: { emailVerificationCode: "", emailVerificationExpiry: "" },
    }
  );

  res.json({ message: "E-Mail erfolgreich bestätigt" });
}

export async function login(req: Request, res: Response) {
  const parseResult = loginSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({ error: parseResult.error.issues[0].message });
  }

  const { email, password } = parseResult.data;
  const db = getDB();
  const users = db.collection<User>("users");

  const user = await users.findOne({ email });
  if (!user) {
    return res.status(401).json({ error: "E-Mail oder Passwort falsch" });
  }

  if (!user.passwordHash) {
    return res.status(401).json({
      error: "Dieses Konto wurde mit Google erstellt. Melde dich mit Google an.",
    });
  }

  if (!user.emailVerified) {
    return res.status(403).json({ error: "E-Mail noch nicht bestätigt" });
  }

  const passwordMatches = await bcrypt.compare(password, user.passwordHash);
  if (!passwordMatches) {
    return res.status(401).json({ error: "E-Mail oder Passwort falsch" });
  }

  issueSession(res, user._id!.toString());
  res.json({ message: "Login erfolgreich", user: publicUser(user) });
}

/**
 * Google sign-in: exchange a Supabase access token for an app session.
 * - known googleId  -> log in
 * - matching email  -> link Google to the existing account, log in
 * - new             -> { needsUsername: true } (frontend then calls /google/complete)
 */
export async function googleAuth(req: Request, res: Response) {
  let identity;
  try {
    identity = await verifySupabaseToken(req.body?.accessToken);
  } catch {
    return res.status(401).json({ error: "Google-Anmeldung ungültig oder abgelaufen" });
  }

  const users = getDB().collection<User>("users");

  const byGoogle = await users.findOne({ googleId: identity.sub });
  if (byGoogle) {
    issueSession(res, byGoogle._id!.toString());
    return res.json({ user: publicUser(byGoogle) });
  }

  const byEmail = await users.findOne({ email: ciExact(identity.email) });
  if (byEmail) {
    await users.updateOne(
      { _id: byEmail._id },
      { $set: { googleId: identity.sub, emailVerified: true } }
    );
    issueSession(res, byEmail._id!.toString());
    return res.json({ user: publicUser(byEmail) });
  }

  return res.json({ needsUsername: true, email: identity.email });
}

/** Second step for brand-new Google users: they pick a username, we create the account. */
export async function googleComplete(req: Request, res: Response) {
  let identity;
  try {
    identity = await verifySupabaseToken(req.body?.accessToken);
  } catch {
    return res.status(401).json({ error: "Google-Anmeldung ungültig oder abgelaufen" });
  }

  const users = getDB().collection<User>("users");

  // Race: the account may have been created between /google and /google/complete.
  const existing =
    (await users.findOne({ googleId: identity.sub })) ??
    (await users.findOne({ email: ciExact(identity.email) }));
  if (existing) {
    if (!existing.googleId) {
      await users.updateOne(
        { _id: existing._id },
        { $set: { googleId: identity.sub, emailVerified: true } }
      );
    }
    issueSession(res, existing._id!.toString());
    return res.json({ user: publicUser(existing) });
  }

  const parsed = updateUsernameSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }
  if (await usernameTaken(parsed.data.username)) {
    return res.status(409).json({ error: "Dieser Username ist bereits vergeben" });
  }

  const newUser: User = {
    email: identity.email,
    username: parsed.data.username,
    googleId: identity.sub,
    emailVerified: true,
    storageLimit: DEFAULT_STORAGE_LIMIT_BYTES,
    createdAt: new Date(),
  };
  const result = await users.insertOne(newUser);

  issueSession(res, result.insertedId.toString());
  res.status(201).json({ user: publicUser({ ...newUser, _id: result.insertedId }) });
}

export async function logout(req: Request, res: Response) {
  res.clearCookie("accessToken");
  res.clearCookie("refreshToken");
  res.json({ message: "Logout erfolgreich" });
}

export async function forgotPassword(req: Request, res: Response) {
    const parseResult = forgotPasswordSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({ error: parseResult.error.issues[0].message });
    }
  
    const { email } = parseResult.data;
    const db = getDB();
    const users = db.collection<User>("users");
  
    const user = await users.findOne({ email });
  
    // Wichtig: IMMER die gleiche Antwort geben, egal ob User existiert oder nicht!
    // Sonst könnte jemand durch Ausprobieren herausfinden, welche E-Mails registriert sind.
    if (user) {
      const resetToken = randomBytes(32).toString("hex");
      const resetExpiry = new Date(Date.now() + 30 * 60 * 1000); // 30 Min gültig
  
      await users.updateOne(
        { email },
        { $set: { passwordResetToken: resetToken, passwordResetExpiry: resetExpiry } }
      );
  
      await sendPasswordResetEmail(email, resetToken);
    }
  
    res.json({ message: "Falls diese E-Mail registriert ist, wurde ein Reset-Link versendet." });
  }

export async function resetPassword(req: Request, res: Response) {
    const parseResult = resetPasswordSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({ error: parseResult.error.issues[0].message });
    }
  
    const { token, newPassword } = parseResult.data;
    const db = getDB();
    const users = db.collection<User>("users");
  
    const user = await users.findOne({ passwordResetToken: token });
  
    if (!user || !user.passwordResetExpiry || user.passwordResetExpiry < new Date()) {
      return res.status(400).json({ error: "Link ungültig oder abgelaufen" });
    }
  
    const passwordHash = await bcrypt.hash(newPassword, 10);
  
    await users.updateOne(
      { _id: user._id },
      {
        $set: { passwordHash },
        $unset: { passwordResetToken: "", passwordResetExpiry: "" },
      }
    );
  
    res.json({ message: "Passwort erfolgreich geändert" });
}

export async function resendVerificationCode(req: Request, res: Response) {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "E-Mail erforderlich" });
  
    const db = getDB();
    const users = db.collection<User>("users");
    const user = await users.findOne({ email });
  
    if (!user || user.emailVerified) {
      // Auch hier: keine Info preisgeben, ob der User existiert
      return res.json({ message: "Falls diese E-Mail registriert und unbestätigt ist, wurde ein neuer Code versendet." });
    }
  
    const verificationCode = generateSixDigitCode();
    await users.updateOne(
      { email },
      {
        $set: {
          emailVerificationCode: verificationCode,
          emailVerificationExpiry: new Date(Date.now() + 15 * 60 * 1000),
        },
      }
    );
  
    await sendVerificationEmail(email, verificationCode);
    res.json({ message: "Falls diese E-Mail registriert und unbestätigt ist, wurde ein neuer Code versendet." });
}

export async function refreshAccessToken(req: Request, res: Response) {
    const refreshToken = req.cookies?.refreshToken;
  
    if (!refreshToken) {
      return res.status(401).json({ error: "Kein Refresh-Token vorhanden" });
    }
  
    let payload: { userId: string };
    try {
      payload = verifyRefreshToken(refreshToken);
    } catch (error) {
      return res.status(401).json({ error: "Refresh-Token ungültig oder abgelaufen" });
    }
  
    // Optional aber empfehlenswert: prüfen ob User noch existiert
    const db = getDB();
    const users = db.collection<User>("users");
    const user = await users.findOne({ _id: new ObjectId(payload.userId) });
  
    if (!user) {
      return res.status(401).json({ error: "User nicht gefunden" });
    }
  
    const newAccessToken = generateAccessToken(payload.userId);
  
    res.cookie("accessToken", newAccessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 15 * 60 * 1000,
    });
  
    res.json({ message: "Access Token erneuert" });
}