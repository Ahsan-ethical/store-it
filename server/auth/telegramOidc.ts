import crypto from "node:crypto";
import connectDB from "@/adapters/database/mongoose";
import User from "@/adapters/database/models/User";
import type { AuthUser } from "./token";

const TELEGRAM_ISSUER = "https://oauth.telegram.org";
const TELEGRAM_AUTHORIZATION_ENDPOINT = `${TELEGRAM_ISSUER}/auth`;
const TELEGRAM_TOKEN_ENDPOINT = `${TELEGRAM_ISSUER}/token`;
const TELEGRAM_JWKS_ENDPOINT = `${TELEGRAM_ISSUER}/.well-known/jwks.json`;

type TelegramClaims = {
  iss?: unknown;
  aud?: unknown;
  exp?: unknown;
  iat?: unknown;
  nonce?: unknown;
  sub?: unknown;
  id?: unknown;
  name?: unknown;
  given_name?: unknown;
  family_name?: unknown;
  preferred_username?: unknown;
  picture?: unknown;
};

type TelegramJwk = JsonWebKey & { kid?: string; alg?: string; use?: string };

let cachedJwks: { keys: TelegramJwk[]; expiresAt: number } | undefined;

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

export function getTelegramOidcConfig() {
  return {
    clientId: requiredEnv("TELEGRAM_OIDC_CLIENT_ID"),
    clientSecret: requiredEnv("TELEGRAM_OIDC_CLIENT_SECRET"),
    redirectUri: requiredEnv("TELEGRAM_OIDC_REDIRECT_URI"),
  };
}

export function createTelegramAuthorization(input: {
  state: string;
  nonce: string;
  codeChallenge: string;
}): string {
  const { clientId, redirectUri } = getTelegramOidcConfig();
  const query = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid profile telegram:bot_access",
    state: input.state,
    nonce: input.nonce,
    code_challenge: input.codeChallenge,
    code_challenge_method: "S256",
  });
  return `${TELEGRAM_AUTHORIZATION_ENDPOINT}?${query.toString()}`;
}

export function randomSecret(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export function createCodeChallenge(verifier: string): string {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

export function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function exchangeTelegramCode(code: string, codeVerifier: string): Promise<string> {
  const { clientId, clientSecret, redirectUri } = getTelegramOidcConfig();
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const response = await fetch(TELEGRAM_TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: codeVerifier,
    }),
    signal: AbortSignal.timeout(15_000),
    cache: "no-store",
  });
  if (!response.ok) throw new Error("Telegram token exchange failed");

  const tokenResponse = await response.json() as { id_token?: unknown };
  if (typeof tokenResponse.id_token !== "string") {
    throw new Error("Telegram did not return an ID token");
  }
  return tokenResponse.id_token;
}

async function getTelegramJwks(): Promise<TelegramJwk[]> {
  if (cachedJwks && cachedJwks.expiresAt > Date.now()) return cachedJwks.keys;

  const response = await fetch(TELEGRAM_JWKS_ENDPOINT, {
    signal: AbortSignal.timeout(10_000),
    cache: "no-store",
  });
  if (!response.ok) throw new Error("Could not load Telegram signing keys");
  const document = await response.json() as { keys?: TelegramJwk[] };
  if (!Array.isArray(document.keys) || document.keys.length === 0) {
    throw new Error("Telegram signing keys are unavailable");
  }

  cachedJwks = { keys: document.keys, expiresAt: Date.now() + 5 * 60_000 };
  return document.keys;
}

function decodeJwtPart<T>(value: string): T {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as T;
}

export async function verifyTelegramIdToken(idToken: string, expectedNonce: string): Promise<TelegramClaims> {
  const segments = idToken.split(".");
  if (segments.length !== 3) throw new Error("Telegram returned a malformed ID token");

  const header = decodeJwtPart<{ alg?: unknown; kid?: unknown }>(segments[0]);
  if (header.alg !== "RS256" || typeof header.kid !== "string") {
    throw new Error("Telegram used an unsupported ID token signature");
  }

  const keys = await getTelegramJwks();
  const jwk = keys.find((key) => key.kid === header.kid && key.kty === "RSA");
  if (!jwk) {
    cachedJwks = undefined;
    throw new Error("Telegram signing key was not found");
  }

  const publicKey = crypto.createPublicKey({ key: jwk as unknown as crypto.JsonWebKey, format: "jwk" });
  const signatureValid = crypto.verify(
    "RSA-SHA256",
    Buffer.from(`${segments[0]}.${segments[1]}`),
    publicKey,
    Buffer.from(segments[2], "base64url"),
  );
  if (!signatureValid) throw new Error("Telegram ID token signature is invalid");

  const claims = decodeJwtPart<TelegramClaims>(segments[1]);
  const { clientId } = getTelegramOidcConfig();
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  const now = Math.floor(Date.now() / 1000);

  if (claims.iss !== TELEGRAM_ISSUER || !audiences.includes(clientId)) {
    throw new Error("Telegram ID token issuer or audience is invalid");
  }
  if (typeof claims.exp !== "number" || claims.exp <= now) {
    throw new Error("Telegram ID token has expired");
  }
  if (typeof claims.iat === "number" && claims.iat > now + 60) {
    throw new Error("Telegram ID token was issued in the future");
  }
  if (typeof claims.nonce !== "string" || !safeEqual(claims.nonce, expectedNonce)) {
    throw new Error("Telegram ID token nonce is invalid");
  }

  const telegramId = typeof claims.id === "number" || typeof claims.id === "string"
    ? String(claims.id)
    : typeof claims.sub === "string" ? claims.sub : "";
  if (!telegramId) throw new Error("Telegram ID token has no user ID");
  return claims;
}

export function getTelegramProfile(claims: TelegramClaims) {
  const telegramId = typeof claims.id === "number" || typeof claims.id === "string"
    ? String(claims.id)
    : String(claims.sub);
  const username = typeof claims.preferred_username === "string"
    ? claims.preferred_username.replace(/^@/, "")
    : null;
  const name = typeof claims.name === "string" && claims.name.trim()
    ? claims.name.trim()
    : [claims.given_name, claims.family_name].filter((part): part is string => typeof part === "string" && !!part.trim()).join(" ")
      || username
      || "Telegram user";
  return { telegramId, username, name };
}

function toAuthUser(user: { _id: { toString(): string }; email: string; provider?: string; storageused?: number; storagelimit?: number; telegramId?: string | null }): AuthUser {
  return {
    userId: user._id.toString(),
    email: user.email,
    provider: user.provider || "telegram",
    storageused: user.storageused || 0,
    storagelimit: user.storagelimit || 5 * 1024 * 1024 * 1024,
    telegramLinked: Boolean(user.telegramId),
  };
}

export async function signInWithTelegram(claims: TelegramClaims): Promise<AuthUser> {
  const profile = getTelegramProfile(claims);
  await connectDB();

  let user = await User.findOne({ telegramId: profile.telegramId });
  if (!user) user = await User.findOne({ provider: "telegram", providerId: profile.telegramId });
  if (!user) user = await User.findOne({ email: `telegram_${profile.telegramId}@telegram.store` });

  if (user) {
    user.telegramId = profile.telegramId;
    user.telegramUsername = profile.username;
    if (user.provider === "telegram") user.providerId = profile.telegramId;
    await user.save();
    return toAuthUser(user);
  }

  try {
    user = await User.create({
      email: `telegram_${profile.telegramId}@telegram.store`,
      name: profile.name,
      provider: "telegram",
      providerId: profile.telegramId,
      telegramId: profile.telegramId,
      telegramUsername: profile.username,
    });
  } catch (error) {
    // A concurrent first login can win the unique email/Telegram ID insert.
    user = await User.findOne({ telegramId: profile.telegramId });
    if (!user) throw error;
  }

  return toAuthUser(user);
}

export async function linkTelegramToUser(userId: string, claims: TelegramClaims): Promise<AuthUser> {
  const profile = getTelegramProfile(claims);
  await connectDB();

  const currentUser = await User.findById(userId).select("telegramId").lean();
  if (!currentUser) throw new Error("StoreIt account not found");
  if (currentUser.telegramId && currentUser.telegramId !== profile.telegramId) {
    throw new Error("This StoreIt account already has a different Telegram account linked");
  }

  const claimed = await User.findOne({ telegramId: profile.telegramId, _id: { $ne: userId } }).select("_id").lean();
  if (claimed) throw new Error("This Telegram account is already linked to another StoreIt account");

  const linkedUser = await User.findByIdAndUpdate(userId, {
    $set: { telegramId: profile.telegramId, telegramUsername: profile.username },
  }, { new: true });
  if (!linkedUser) throw new Error("StoreIt account not found");
  return toAuthUser(linkedUser);
}
