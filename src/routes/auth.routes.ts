import { Router } from "express";
import { asyncHandler } from "../middleware/errorHandler";
import { authLimiter } from "../middleware/rateLimiter";
import { register, verifyEmail, login, logout, forgotPassword, resetPassword,
     resendVerificationCode, refreshAccessToken, googleAuth, googleComplete } from "../controllers/auth.controller";

const router = Router();

router.use(authLimiter);

router.post("/register", asyncHandler(register));
router.post("/verify-email", asyncHandler(verifyEmail));
router.post("/resend-verification-code", asyncHandler(resendVerificationCode));
router.post("/login", asyncHandler(login));
router.post("/google", asyncHandler(googleAuth));
router.post("/google/complete", asyncHandler(googleComplete));
router.post("/logout", asyncHandler(logout));
router.post("/forgot-password", asyncHandler(forgotPassword));
router.post("/reset-password", asyncHandler(resetPassword));
router.post("/refresh", asyncHandler(refreshAccessToken));

export default router;