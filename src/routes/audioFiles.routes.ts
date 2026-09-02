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
  enableProjectShare,
  disableProjectShare,
  getSharedProject,
  reorderAudioFiles,
  initVersionUpload,
  confirmVersionUpload,
  updateVersion,
  selectVersion,
  deleteVersion,
  initVersionProject,
  confirmVersionProject,
  downloadVersionProject,
  deleteVersionProject,
} from "../controllers/audioFiles.controller";

const router = Router();

// Öffentliche Routen (kein Login) - MÜSSEN vor requireAuth stehen
router.get("/public/stream/:shareToken", streamSharedAudioFile);
router.get("/public/project/:token", getSharedProject);

router.use(requireAuth);

// Playlist-bezogene Upload-Routen
router.post("/playlists/:playlistId/reorder", asyncHandler(reorderAudioFiles));
router.post("/playlists/:playlistId/init-upload", asyncHandler(initAudioUpload));
router.post("/playlists/:playlistId/confirm-upload", asyncHandler(confirmAudioUpload));
router.get("/playlists/:playlistId", asyncHandler(getAudioFilesByPlaylist));

// Versionen (spezifische Routen VOR generischem /:id)
router.post("/:id/versions/init", asyncHandler(initVersionUpload));
router.post("/:id/versions/confirm", asyncHandler(confirmVersionUpload));
router.patch("/:id/versions/:vid", asyncHandler(updateVersion));
router.post("/:id/versions/:vid/select", asyncHandler(selectVersion));
router.delete("/:id/versions/:vid", asyncHandler(deleteVersion));

// Projektdateien einer Version
router.post("/:id/versions/:vid/project/init", asyncHandler(initVersionProject));
router.post("/:id/versions/:vid/project/confirm", asyncHandler(confirmVersionProject));
router.get("/:id/versions/:vid/project/download", asyncHandler(downloadVersionProject));
router.delete("/:id/versions/:vid/project", asyncHandler(deleteVersionProject));

// Einzelner Track
router.get("/:id", asyncHandler(getAudioFileById));
router.patch("/:id", asyncHandler(updateAudioFile));
router.post("/:id/cover-upload-url", asyncHandler(getAudioFileCoverUploadUrl));
router.delete("/:id", asyncHandler(deleteAudioFile));
router.get("/:id/stream", asyncHandler(streamAudioFile));
router.post("/:id/share", asyncHandler(enableShare));
router.post("/:id/unshare", asyncHandler(disableShare));
router.post("/:id/project-share", asyncHandler(enableProjectShare));
router.post("/:id/project-unshare", asyncHandler(disableProjectShare));

export default router;
