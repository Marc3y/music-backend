const ALLOWED_MIME_TYPES = [
    "audio/mpeg",       // mp3
    "audio/wav",
    "audio/x-wav",
    "audio/flac",
    "audio/x-flac",
    "audio/mp4",        // m4a
    "audio/aac",
    "audio/ogg",
  ];

  export function isAllowedAudioType(mimeType: string): boolean {
    return ALLOWED_MIME_TYPES.includes(mimeType);
  }

  const PROJECT_MIME_TYPES = [
    "application/zip",
    "application/x-zip-compressed",
    "application/x-rar-compressed",
    "application/vnd.rar",
    "application/x-rar",
    "application/octet-stream", // Browser liefern für .rar oft nichts Besseres
  ];

  // Projektdateien: .zip / .rar. MIME ist bei Archiven unzuverlässig, daher zählt
  // primär die Dateiendung.
  export function isAllowedProjectFile(filename: string, mimeType: string): boolean {
    const lower = filename.toLowerCase();
    if (lower.endsWith(".zip") || lower.endsWith(".rar")) return true;
    return PROJECT_MIME_TYPES.includes(mimeType);
  }
