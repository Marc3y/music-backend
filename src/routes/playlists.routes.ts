import { Router } from "express";
import { requireAuth, optionalAuth } from "../middleware/auth.middleware";
import { asyncHandler } from "../middleware/errorHandler";
import {
  createPlaylist,
  getPlaylists,
  getPlaylistById,
  updatePlaylist,
  deletePlaylist,
  getPlaylistCoverUploadUrl,
  updatePlaylistShare,
  updateCollaborators,
  joinPlaylist,
  getSharedPlaylist,
  getSharedPlaylistStream,
  getSharedPlaylistProject,
} from "../controllers/playlists.controller";

const router = Router();

// Öffentliche Playlist-Ansicht (Login optional) - VOR requireAuth
router.get("/public/:token", optionalAuth, asyncHandler(getSharedPlaylist));
router.get(
  "/public/:token/tracks/:trackId/stream",
  optionalAuth,
  asyncHandler(getSharedPlaylistStream)
);
router.get(
  "/public/:token/tracks/:trackId/project",
  optionalAuth,
  asyncHandler(getSharedPlaylistProject)
);

router.use(requireAuth); // alle weiteren Playlist-Routen brauchen Login

router.post("/", asyncHandler(createPlaylist));
router.get("/", asyncHandler(getPlaylists));
router.post("/join/:token", asyncHandler(joinPlaylist));
router.get("/:id", asyncHandler(getPlaylistById));
router.patch("/:id", asyncHandler(updatePlaylist));
router.patch("/:id/share", asyncHandler(updatePlaylistShare));
router.patch("/:id/collaborators", asyncHandler(updateCollaborators));
router.delete("/:id", asyncHandler(deletePlaylist));
router.post("/:id/cover-upload-url", asyncHandler(getPlaylistCoverUploadUrl));

export default router;
