// Standard-Speicherlimit pro User (in Bytes). Kann pro User im `users`-Dokument
// über das Feld `storageLimit` überschrieben werden.
export const DEFAULT_STORAGE_LIMIT_BYTES = 5 * 1024 * 1024 * 1024; // 5 GiB

// Platzhalter bis zur finalen Festlegung: music+ = 500 GB.
export const PLUS_STORAGE_LIMIT_BYTES = 500 * 1024 * 1024 * 1024;

// Sentinel für "unbegrenzt" (music unlimited).
export const UNLIMITED_STORAGE = Number.MAX_SAFE_INTEGER;

export type Tier = "free" | "plus" | "unlimited";

export function tierRank(tier: Tier | undefined | null): number {
  return tier === "unlimited" ? 2 : tier === "plus" ? 1 : 0;
}

export function hasPlus(tier: Tier | undefined | null): boolean {
  return tierRank(tier) >= 1;
}

export function isUnlimited(tier: Tier | undefined | null): boolean {
  return tier === "unlimited";
}

export function storageLimitForTier(
  tier: Tier | undefined | null,
  userOverride?: number
): number {
  if (tier === "unlimited") return UNLIMITED_STORAGE;
  if (tier === "plus") return PLUS_STORAGE_LIMIT_BYTES;
  return typeof userOverride === "number" ? userOverride : DEFAULT_STORAGE_LIMIT_BYTES;
}
