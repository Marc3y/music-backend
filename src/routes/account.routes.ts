import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware";
import { asyncHandler } from "../middleware/errorHandler";
import { authLimiter } from "../middleware/rateLimiter";
import {
  getMe,
  getStorageSummary,
  getUsage,
  updateUsername,
  getAvatarUploadUrl,
  deleteAvatar,
  requestPasswordChange,
  confirmPasswordChange,
  requestAccountDeletion,
  confirmAccountDeletion,
  addSavedShare,
  listSavedShares,
  removeSavedShare,
} from "../controllers/account.controller";

const router = Router();

router.use(requireAuth);

router.get("/me", asyncHandler(getMe));
router.get("/storage", asyncHandler(getStorageSummary));
router.get("/usage", asyncHandler(getUsage));
router.get("/saved-shares", asyncHandler(listSavedShares));
router.post("/saved-shares", asyncHandler(addSavedShare));
router.delete("/saved-shares/:id", asyncHandler(removeSavedShare));
router.patch("/username", asyncHandler(updateUsername));
router.post("/avatar-upload-url", asyncHandler(getAvatarUploadUrl));
router.delete("/avatar", asyncHandler(deleteAvatar));

router.post("/password/request", authLimiter, asyncHandler(requestPasswordChange));
router.post("/password/confirm", authLimiter, asyncHandler(confirmPasswordChange));
router.post("/delete/request", authLimiter, asyncHandler(requestAccountDeletion));
router.post("/delete/confirm", authLimiter, asyncHandler(confirmAccountDeletion));

export default router;
