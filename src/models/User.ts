import { ObjectId } from "mongodb";

export interface User {
  _id?: ObjectId;
  email: string;
  username: string;
  passwordHash?: string;
  googleId?: string;
  emailVerified: boolean;
  emailVerificationCode?: string;
  emailVerificationExpiry?: Date;
  passwordResetToken?: string;
  passwordResetExpiry?: Date;
  avatarKey?: string;
  storageLimit?: number; // Bytes; Default siehe config/limits.ts
  pendingPasswordHash?: string;
  passwordChangeCode?: string;
  passwordChangeExpiry?: Date;
  accountDeletionCode?: string;
  accountDeletionExpiry?: Date;
  createdAt: Date;
}