import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware";
import { asyncHandler } from "../middleware/errorHandler";
import {
  initAudioUpload,
  confirmAudioUpload,
  getAudioFilesByPlaylist,
  getAudioFileById,
  updateAudioFile,
  getAudioFileCoverUploadUrl,
  deleteAudioFile,
  streamAudioFile,
  enableShare,
  disableShare,
  streamSharedAudioFile,
} from "../controllers/audioFiles.controller";

const router = Router();

// Öffentliche Route (kein Login) - MUSS vor requireAuth stehen
router.get("/public/stream/:shareToken", streamSharedAudioFile);

router.use(requireAuth);

// Playlist-bezogene Upload-Routen
router.post("/playlists/:playlistId/init-upload", asyncHandler(initAudioUpload));
router.post("/playlists/:playlistId/confirm-upload", asyncHandler(confirmAudioUpload));
router.get("/playlists/:playlistId", asyncHandler(getAudioFilesByPlaylist));

// Einzelner Track
router.get("/:id", asyncHandler(getAudioFileById));
router.patch("/:id", asyncHandler(updateAudioFile));
router.post("/:id/cover-upload-url", asyncHandler(getAudioFileCoverUploadUrl));
router.delete("/:id", asyncHandler(deleteAudioFile));
router.get("/:id/stream", asyncHandler(streamAudioFile));
router.post("/:id/share", asyncHandler(enableShare));
router.post("/:id/unshare", asyncHandler(disableShare));

export default router;