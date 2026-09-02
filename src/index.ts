import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import { connectDB } from "./config/db";
import authRoutes from "./routes/auth.routes";
import accountRoutes from "./routes/account.routes";
import playlistsRoutes from "./routes/playlists.routes";
import audioFilesRoutes from "./routes/audioFiles.routes";
import { errorHandler } from "./middleware/errorHandler";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cookieParser());
app.use(cors({ origin: process.env.FRONTEND_URL, credentials: true })); // Frontend-URL später anpassen

app.use("/auth", authRoutes);
app.use("/account", accountRoutes);
app.use("/playlists", playlistsRoutes);
app.use("/audio-files", audioFilesRoutes);
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

async function startServer() {
  try {
    await connectDB();
    app.listen(PORT, () => {
      console.log(`🚀 Server läuft auf http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error("❌ Fehler beim Starten:", error);
    process.exit(1);
  }
}

startServer();

app.use(errorHandler);