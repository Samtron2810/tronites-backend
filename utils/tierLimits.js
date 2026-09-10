// ─────────────────────────────────────────────────────────────────────────────
// Tier-based feature limits.
//
// A user's "active tier" is the highest-priority verification badge they
// currently hold — staff > government > business > creator > individual
// (same precedence as frontend/src/constants/verification.js). Badges are
// claims stored in `verifications[]` and each has an optional expiresAt;
// an expired badge stops counting. A user with no active badge is
// "unverified".
//
// Feature        | Unverified | Individual | Creator | Business | Government | Staff
// ───────────────┼────────────┼────────────┼─────────┼──────────┼────────────┼──────
// Char limit     | 280        | 500        | 1000    | 1000     | 1000       | 5000
// Scheduling     | ❌         | ✅         | ✅      | ✅       | ✅         | ✅
// Pinned posts   | 0          | 1          | 3       | 3        | 3          | 5
// Edit window    | n/a (none) | 15 min     | 30 min  | 30 min   | 60 min     | ∞
// Promoted posts | ❌         | ❌         | ❌      | ✅       | ❌         | ❌
// ─────────────────────────────────────────────────────────────────────────────

const TIER_PRIORITY = ["staff", "government", "business", "creator", "individual"];

// True when a user holds an unexpired badge of the given type.
const hasActiveBadge = (verifications, type) => {
  if (!Array.isArray(verifications)) return false;
  const now = new Date();
  return verifications.some(
    (v) =>
      v?.type === type &&
      (!v.expiresAt || new Date(v.expiresAt) > now),
  );
};

// Highest-priority active badge, or "unverified" when none.
export const getActiveTier = (user) => {
  const verifications = user?.verifications;
  if (!Array.isArray(verifications)) return "unverified";
  for (const tier of TIER_PRIORITY) {
    if (hasActiveBadge(verifications, tier)) return tier;
  }
  return "unverified";
};

// Any active badge at all — the "verified" umbrella tier.
export const isVerified = (user) => getActiveTier(user) !== "unverified";

// ── Longer posts (char limit) ──────────────────────────────────────────────
export const POST_CHAR_LIMITS = {
  unverified: 280,
  individual: 500,
  creator: 1000,
  business: 1000,
  government: 1000,
  // Staff is capped at the storage/validator ceiling (MAX_POST_TEXT) rather
  // than literally unlimited, so a runaway post can't blow up memory.
  staff: 5000,
};

// Hard ceiling every tier is validated against (zod + Post model). Keep in
// sync with backend/utils/validators.js .max() and backend/models/Post.js
// text.maxlength.
export const MAX_POST_TEXT = 5000;

export const getCharLimit = (user) =>
  POST_CHAR_LIMITS[getActiveTier(user)] ?? POST_CHAR_LIMITS.unverified;

// ── Post scheduling ─────────────────────────────────────────────────────────
// Every verified tier can schedule; unverified cannot.
export const canSchedule = (user) => getActiveTier(user) !== "unverified";

// ── Pinned posts ────────────────────────────────────────────────────────────
export const PINNED_POST_LIMITS = {
  unverified: 0,
  individual: 1,
  creator: 3,
  business: 3,
  government: 3,
  staff: 5,
};

export const getPinnedLimit = (user) =>
  PINNED_POST_LIMITS[getActiveTier(user)] ?? 0;

// ── Promoted posts (paid boost) ─────────────────────────────────────────────
// Business tier only.
export const canPromote = (user) => getActiveTier(user) === "business";

// ── Edit post window ────────────────────────────────────────────────────────
// Flat cooldown between successive edits, regardless of tier.
export const POST_EDIT_COOLDOWN_MS = 5 * 60 * 1000;

const MINUTE_MS = 60 * 1000;

// How long after post CREATION a user may still edit. null = editing is not
// available at all (unverified); Infinity = no time limit (staff).
export const POST_EDIT_WINDOW_MS = {
  unverified: null,
  individual: 15 * MINUTE_MS,
  creator: 30 * MINUTE_MS,
  business: 30 * MINUTE_MS,
  government: 60 * MINUTE_MS,
  staff: Infinity,
};

// Editing is a verified-tier feature — unverified accounts can't edit.
export const canEditPost = (user) => getActiveTier(user) !== "unverified";

// Edit window in ms, or null when the tier can't edit at all.
export const getEditWindowMs = (user) =>
  POST_EDIT_WINDOW_MS[getActiveTier(user)] ?? null;