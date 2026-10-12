import rateLimit from "express-rate-limit";

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 25,
  message: { error: "Zu viele Versuche. Bitte später erneut versuchen." },
  standardHeaders: true,
  legacyHeaders: false,
});
