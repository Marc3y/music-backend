/**
 * Normalises a musical-key string to the compact English form used across the app:
 *   minor -> "<note>m"     (e.g. "F#m")
 *   major -> "<note> maj"  (e.g. "F# maj")
 * Handles the old German values ("F# moll" / "F# dur") and common English variants.
 * Returns the trimmed input unchanged if it can't be parsed.
 */
export function normalizeKey(raw?: string | null): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;

  const m = s.match(
    /^([A-Ga-g][#b♯♭]?)\s*(moll|minor|min|m|dur|major|maj|maj7)?$/i
  );
  if (!m) return s;

  const note =
    m[1][0].toUpperCase() + m[1].slice(1).replace("♯", "#").replace("♭", "b").toLowerCase();
  const mode = (m[2] ?? "").toLowerCase();
  const isMinor = mode === "moll" || mode === "minor" || mode === "min" || mode === "m";
  return isMinor ? `${note}m` : `${note} maj`;
}
