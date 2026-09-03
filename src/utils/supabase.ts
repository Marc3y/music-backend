const SUPABASE_URL = process.env.SUPABASE_URL as string;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY as string;

export interface SupabaseIdentity {
  sub: string;
  email: string;
  name?: string;
  avatarUrl?: string;
}

export class SupabaseConfigError extends Error {}
export class SupabaseTokenError extends Error {}

/**
 * Verifies a Supabase user access token by asking Supabase who it belongs to.
 * Throws SupabaseConfigError (server misconfigured) or SupabaseTokenError
 * (token missing / invalid / expired).
 */
export async function verifySupabaseToken(
  accessToken: unknown
): Promise<SupabaseIdentity> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new SupabaseConfigError(
      "SUPABASE_URL / SUPABASE_ANON_KEY not set on the server"
    );
  }
  if (!accessToken || typeof accessToken !== "string") {
    throw new SupabaseTokenError("no access token in request body");
  }

  let res: Response;
  try {
    res = await fetch(`${SUPABASE_URL.replace(/\/$/, "")}/auth/v1/user`, {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${accessToken}`,
      },
    });
  } catch (err) {
    throw new SupabaseConfigError(
      `could not reach Supabase: ${(err as Error).message}`
    );
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new SupabaseTokenError(
      `Supabase /auth/v1/user -> ${res.status}: ${body.slice(0, 300)}`
    );
  }

  const user = (await res.json()) as {
    id?: string;
    email?: string;
    user_metadata?: Record<string, unknown>;
  };

  if (!user.id || !user.email) {
    throw new SupabaseTokenError("Supabase user has no id/email");
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
