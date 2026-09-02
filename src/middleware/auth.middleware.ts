import { Request, Response, NextFunction } from "express";
import { verifyAccessToken } from "../utils/tokens";

export interface AuthRequest extends Request {
  userId?: string;
}

export function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  const token = req.cookies?.accessToken;

  if (!token) {
    return res.status(401).json({ error: "Nicht eingeloggt" });
  }

  try {
    const payload = verifyAccessToken(token);
    req.userId = payload.userId;
    next();
  } catch (error) {
    return res.status(401).json({ error: "Session abgelaufen oder ungültig" });
  }
}

// Setzt req.userId, wenn ein gültiges Access-Token vorliegt – blockiert aber nie.
export function optionalAuth(req: AuthRequest, _res: Response, next: NextFunction) {
  const token = req.cookies?.accessToken;
  if (token) {
    try {
      req.userId = verifyAccessToken(token).userId;
    } catch {
      // anonym weiter
    }
  }
  next();
}