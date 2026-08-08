import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware";
import { asyncHandler } from "../middleware/errorHandler";
import {
  createPlaylist,
  getPlaylists,
  getPlaylistById,
  updatePlaylist,
  deletePlaylist,
  getPlaylistCoverUploadUrl,
} from "../controllers/playlists.controller";

const router = Router();

router.use(requireAuth); // alle Playlist-Routen brauchen Login

router.post("/", asyncHandler(createPlaylist));
router.get("/", asyncHandler(getPlaylists));
router.get("/:id", asyncHandler(getPlaylistById));
router.patch("/:id", asyncHandler(updatePlaylist));
router.delete("/:id", asyncHandler(deletePlaylist));
router.post("/:id/cover-upload-url", asyncHandler(getPlaylistCoverUploadUrl));

export default router;