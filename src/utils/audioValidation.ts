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