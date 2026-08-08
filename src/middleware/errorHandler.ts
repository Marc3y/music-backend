import { Request, Response, NextFunction } from "express";

export function errorHandler(
  err: any,
  req: Request,
  res: Response,
  next: NextFunction
) {
  console.error("❌ Unerwarteter Fehler:", err);

  // Falls schon eine Antwort gesendet wurde, an Express weiterreichen
  if (res.headersSent) {
    return next(err);
  }

  res.status(500).json({ error: "Ein interner Serverfehler ist aufgetreten." });
}

// Fängt Fehler in async Route-Handlern ab, die sonst "verschluckt" würden
export function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<any>) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}