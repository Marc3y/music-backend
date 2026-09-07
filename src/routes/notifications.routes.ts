import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware";
import { asyncHandler } from "../middleware/errorHandler";
import {
  listNotifications,
  markNotificationsRead,
  streamNotifications,
} from "../controllers/notifications.controller";

const router = Router();

router.use(requireAuth);

router.get("/", asyncHandler(listNotifications));
router.post("/read", asyncHandler(markNotificationsRead));
router.get("/stream", streamNotifications);

export default router;
