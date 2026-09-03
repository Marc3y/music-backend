const SUPABASE_URL = process.env.SUPABASE_URL as string;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY as string;

export interface SupabaseIdentity {
  sub: string;
  email: string;
  name?: string;
  avatarUrl?: string;
}

/**
 * Verifies a Supabase user access token by asking Supabase who it belongs to.
 * Throws if the token is missing/invalid/expired or has no email.
 */
export async function verifySupabaseToken(
  accessToken: string
): Promise<SupabaseIdentity> {
  if (!accessToken || typeof accessToken !== "string") {
    throw new Error("no token");
  }
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error("Supabase env not configured");
  }

  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!res.ok) {
    throw new Error(`Supabase token invalid (${res.status})`);
  }

  const user = (await res.json()) as {
    id?: string;
    email?: string;
    user_metadata?: Record<string, unknown>;
  };

  if (!user.id || !user.email) {
    throw new Error("Supabase user without id/email");
  }

  const meta = user.user_metadata ?? {};
  const name =
    (typeof meta.full_name === "string" && meta.full_name) ||
    (typeof meta.name === "string" && meta.name) ||
    undefined;
  const avatarUrl =
    (typeof meta.avatar_url === "string" && meta.avatar_url) ||
    (typeof meta.picture === "string" && meta.picture) ||
    undefined;

  return { sub: user.id, email: user.email.toLowerCase(), name, avatarUrl };
}
