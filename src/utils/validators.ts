import { z } from "zod";

export const registerSchema = z.object({
  email: z.string().email("Ungültige E-Mail-Adresse"),
  username: z.string().min(3, "Username muss mindestens 3 Zeichen haben").max(30),
  password: z.string().min(8, "Passwort muss mindestens 8 Zeichen haben"),
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1, "Passwort erforderlich"),
});

export const verifyEmailSchema = z.object({
  email: z.string().email(),
  code: z.string().length(6, "Code muss 6 Zeichen haben"),
});

export const createPlaylistSchema = z.object({
  name: z.string().min(1, "Name erforderlich").max(100),
});
  
export const updatePlaylistSchema = z.object({
  name: z.string().min(1).max(100).optional(),
});
  
export const uploadUrlRequestSchema = z.object({
  filename: z.string().min(1),
  contentType: z.string().min(1),
});

export const initAudioUploadSchema = z.object({
  filename: z.string().min(1),
  contentType: z.string().min(1),
  fileSize: z.number().positive().max(500 * 1024 * 1024), // Max 500 MB
});
  
export const confirmAudioUploadSchema = z.object({
  key: z.string().min(1),
  originalFilename: z.string().min(1),
  fileSize: z.number().positive(),
  mimeType: z.string().min(1),
});
  
export const updateAudioFileSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  artist: z.string().max(200).optional(),
  description: z.string().max(1000).optional(),
});

export const forgotPasswordSchema = z.object({
    email: z.string().email(),
});
  
export const resetPasswordSchema = z.object({
    token: z.string().min(1),
    newPassword: z.string().min(8, "Passwort muss mindestens 8 Zeichen haben"),
});

export const updateUsernameSchema = z.object({
    username: z.string().min(3, "Username muss mindestens 3 Zeichen haben").max(30),
});

export const changePasswordRequestSchema = z.object({
    currentPassword: z.string().min(1, "Aktuelles Passwort erforderlich"),
    newPassword: z.string().min(8, "Passwort muss mindestens 8 Zeichen haben"),
});

export const codeConfirmSchema = z.object({
    code: z.string().length(6, "Code muss 6 Zeichen haben"),
});

export const deleteAccountRequestSchema = z.object({
    password: z.string().min(1, "Passwort erforderlich"),
});