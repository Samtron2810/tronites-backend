import jwt from "jsonwebtoken";
import crypto from "crypto";
import Session from "../models/Session.js";

const ACCESS_COOKIE_NAME = "token";
const REFRESH_COOKIE_NAME = "refreshToken";

const ACCESS_TOKEN_TTL = "15m";
const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Dedicated secret for hashing refresh tokens at rest, same reasoning as
// OTP_HASH_SECRET in utils/otp.js — a leaked hash secret shouldn't also
// compromise JWT_SECRET (which signs the access token) or vice versa.
// Falls back to JWT_SECRET so this doesn't force a new mandatory env var.
const REFRESH_HASH_SECRET =
  process.env.REFRESH_HASH_SECRET || process.env.JWT_SECRET;

if (!process.env.REFRESH_HASH_SECRET) {
  console.warn(
    "REFRESH_HASH_SECRET is not set — falling back to JWT_SECRET for refresh token hashing. Recommended: set a dedicated REFRESH_HASH_SECRET.",
  );
}

// Single source of truth for both cookies' shared attributes — see the
// original comment in generateToken.js on why an explicit path matters.
const baseCookieOptions = () => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
  path: "/",
});

const hashRefreshToken = (token) =>
  crypto.createHmac("sha256", REFRESH_HASH_SECRET).update(token).digest("hex");

const timingSafeEqualHash = (candidateHash, storedHash) => {
  const a = Buffer.from(candidateHash, "hex");
  const b = Buffer.from(storedHash, "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
};

const signAccessToken = (userId) =>
  jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: ACCESS_TOKEN_TTL });

const generateRefreshToken = () => crypto.randomBytes(48).toString("base64url");

// Issues a brand-new session: a signed 15m access token (short-lived by
// design — nothing revokes it early, so it has to expire fast on its
// own) plus a random 30d refresh token, stored server-side only as its
// hash. Sets both cookies. Used at login/register.
// Returns the created Session doc (previously void) so callers that
// need to distinguish "this exact session" from others for the same
// user — e.g. the new-device alert excluding its own just-created row —
// don't have to re-query by tokenHash.
export const issueSession = async (res, userId, { userAgent = "", ip = "" } = {}) => {
  const accessToken = signAccessToken(userId);
  const refreshToken = generateRefreshToken();

  const session = await Session.create({
    user: userId,
    tokenHash: hashRefreshToken(refreshToken),
    userAgent,
    ip,
    expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
  });

  res.cookie(ACCESS_COOKIE_NAME, accessToken, {
    ...baseCookieOptions(),
    maxAge: ACCESS_TOKEN_TTL_MS,
  });
  res.cookie(REFRESH_COOKIE_NAME, refreshToken, {
    ...baseCookieOptions(),
    maxAge: REFRESH_TOKEN_TTL_MS,
  });

  return session;
};

// Rotates a refresh token: verifies the presented token against its
// stored hash, mints a new access token + new refresh token, and
// replaces the Session doc's hash in place (same doc, so
// createdAt/session identity survives rotation for the future "Sessions"
// screen). The old refresh token is dead the instant this returns —
// reusing it afterward hits the "not found" path below since the hash
// no longer matches any stored session.
//
// Returns null if the token doesn't match any live session (expired,
// already rotated past, or never existed) — the caller treats that as
// "not authorized, log in again".
export const refreshSession = async (res, presentedToken) => {
  if (!presentedToken) return null;

  const presentedHash = hashRefreshToken(presentedToken);

  // Can't look up by exact hash match with a query filter and still be
  // timing-safe, so pull the candidate by an indexed equality lookup
  // (fine — the thing being protected is bulk enumeration/timing attack
  // on a *specific* token, not on tokenHash existence) then confirm with
  // a constant-time comparison before trusting it.
  const session = await Session.findOne({ tokenHash: presentedHash });

  if (!session || session.expiresAt < new Date()) return null;
  if (!timingSafeEqualHash(presentedHash, session.tokenHash)) return null;

  const newRefreshToken = generateRefreshToken();
  session.tokenHash = hashRefreshToken(newRefreshToken);
  session.lastUsedAt = new Date();
  session.expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);
  await session.save();

  const accessToken = signAccessToken(session.user.toString());

  res.cookie(ACCESS_COOKIE_NAME, accessToken, {
    ...baseCookieOptions(),
    maxAge: ACCESS_TOKEN_TTL_MS,
  });
  res.cookie(REFRESH_COOKIE_NAME, newRefreshToken, {
    ...baseCookieOptions(),
    maxAge: REFRESH_TOKEN_TTL_MS,
  });

  return { userId: session.user.toString() };
};

// Revokes the session tied to this refresh token (logout on this
// device). Silently no-ops if the token doesn't match anything — logout
// should always succeed from the client's perspective even against a
// stale/already-revoked cookie.
export const revokeSession = async (presentedToken) => {
  if (!presentedToken) return;
  await Session.deleteOne({ tokenHash: hashRefreshToken(presentedToken) });
};

// Revokes every session for a user — "log out other devices" and the
// password-change/reset flow both need this. Deliberately not scoped to
// "all except this one" here; callers that need to preserve the current
// session re-issue a fresh one immediately after calling this.
export const revokeAllSessions = async (userId) => {
  await Session.deleteMany({ user: userId });
};

// "Log out other devices" — same as revokeAllSessions but keeps the
// caller's own session alive. presentedToken is the current request's
// refresh cookie; hashed the same way it's stored so we can exclude it
// with a single deleteMany rather than delete-all + reissue.
export const revokeAllSessionsExcept = async (userId, presentedToken) => {
  const keepHash = presentedToken ? hashRefreshToken(presentedToken) : null;
  const filter = { user: userId };
  if (keepHash) filter.tokenHash = { $ne: keepHash };
  const result = await Session.deleteMany(filter);
  return result.deletedCount || 0;
};

// Used by the sessions list endpoint to flag which row is "this device"
// — hash the presented refresh cookie the same way it's stored and
// compare against each session's tokenHash. Not security-sensitive
// (display-only), so no timing-safe comparison needed here.
export const hashPresentedRefreshToken = (presentedToken) =>
  presentedToken ? hashRefreshToken(presentedToken) : null;

export const clearAuthCookies = (res) => {
  res.cookie(ACCESS_COOKIE_NAME, "", { ...baseCookieOptions(), expires: new Date(0) });
  res.cookie(REFRESH_COOKIE_NAME, "", { ...baseCookieOptions(), expires: new Date(0) });
};

export { ACCESS_COOKIE_NAME, REFRESH_COOKIE_NAME };
