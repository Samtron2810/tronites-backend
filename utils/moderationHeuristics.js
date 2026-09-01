// Phase 7 — pre-moderation heuristics (roadmap 3.2). Pure, synchronous,
// zero-dependency functions so they're cheap enough to run inline on the
// create-content hot path (postController etc.) with no external calls.
// Every function returns a signal name (string) or null — never throws,
// never blocks. Orchestration (turning signals into a queued Report)
// lives in services/preModerationService.js.
//
// Deliberately conservative: false positives land in the moderation
// queue for a human to dismiss, never auto-delete anything (see roadmap
// note: "route to a Needs review queue rather than auto-deleting").

// Small, deliberately generic seed list — real deployments should load
// this from a managed wordlist/service. Kept short and lowercase; the
// matcher checks word boundaries so it doesn't false-positive on
// substrings inside unrelated words.
const SLUR_PATTERNS = (process.env.MODERATION_SLUR_LIST || "")
  .split(",")
  .map((w) => w.trim().toLowerCase())
  .filter(Boolean);

const URL_PATTERN = /https?:\/\/[^\s]+/gi;
const ALL_CAPS_MIN_LENGTH = parseInt(
  process.env.MODERATION_ALLCAPS_MIN_LENGTH || "20",
  10,
);
const ALL_CAPS_RATIO_THRESHOLD = parseFloat(
  process.env.MODERATION_ALLCAPS_RATIO || "0.7",
);
const LINK_SPAM_MIN_LINKS = parseInt(
  process.env.MODERATION_LINK_SPAM_MIN_LINKS || "3",
  10,
);
const NEW_ACCOUNT_WINDOW_MS =
  parseInt(process.env.MODERATION_NEW_ACCOUNT_HOURS || "24", 10) *
  60 *
  60 *
  1000;
const VELOCITY_WINDOW_MS =
  parseInt(process.env.MODERATION_VELOCITY_WINDOW_MINUTES || "10", 10) *
  60 *
  1000;
const VELOCITY_MAX_POSTS = parseInt(
  process.env.MODERATION_VELOCITY_MAX_POSTS || "8",
  10,
);

// Escapes regex metacharacters in a user-supplied wordlist entry.
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const slurListRegex = SLUR_PATTERNS.length
  ? new RegExp(`\\b(${SLUR_PATTERNS.map(escapeRegex).join("|")})\\b`, "i")
  : null;

/** Blocklist match against a configured term list (env-driven, empty by default). */
export const checkSlurList = (text) => {
  if (!slurListRegex || !text) return null;
  return slurListRegex.test(text) ? "slur_list" : null;
};

/** 3+ links in one piece of text — classic spam-bot shape. */
export const checkLinkSpam = (text) => {
  if (!text) return null;
  const matches = text.match(URL_PATTERN);
  return matches && matches.length >= LINK_SPAM_MIN_LINKS ? "link_spam" : null;
};

/** Long, mostly-uppercase text (shouting / spam formatting). */
export const checkAllCapsRatio = (text) => {
  if (!text || text.length < ALL_CAPS_MIN_LENGTH) return null;
  const letters = text.replace(/[^a-zA-Z]/g, "");
  if (letters.length < ALL_CAPS_MIN_LENGTH) return null;
  const upper = letters.replace(/[^A-Z]/g, "");
  return upper.length / letters.length >= ALL_CAPS_RATIO_THRESHOLD
    ? "all_caps"
    : null;
};

/** Brand-new account (< window) posting an external link — classic spam-account shape. */
export const checkNewAccountWithLink = (text, userCreatedAt) => {
  if (!text || !userCreatedAt) return null;
  const accountAgeMs = Date.now() - new Date(userCreatedAt).getTime();
  if (accountAgeMs > NEW_ACCOUNT_WINDOW_MS) return null;
  return URL_PATTERN.test(text) ? "new_account_link" : null;
};

/**
 * Repeat-posting velocity — more than MODERATION_VELOCITY_MAX_POSTS posts
 * from the same author inside VELOCITY_WINDOW_MS. Caller supplies the
 * count (a cheap indexed count query); kept as an argument rather than a
 * DB call here so this file stays pure/testable and callers control when
 * the query runs.
 */
export const checkPostingVelocity = (recentPostCount) => {
  if (typeof recentPostCount !== "number") return null;
  return recentPostCount >= VELOCITY_MAX_POSTS ? "posting_velocity" : null;
};

export const MODERATION_THRESHOLDS = {
  NEW_ACCOUNT_WINDOW_MS,
  VELOCITY_WINDOW_MS,
  VELOCITY_MAX_POSTS,
  LINK_SPAM_MIN_LINKS,
  ALL_CAPS_MIN_LENGTH,
  ALL_CAPS_RATIO_THRESHOLD,
};

// Reset URL_PATTERN's lastIndex between calls — it's a global-flag regex
// reused across checkLinkSpam/checkNewAccountWithLink, and .test()/.match()
// on a `g` regex is stateful across calls on the SAME instance. Each
// export above triggers a fresh match/test call so this is safe as
// written, but guarded here in case future edits chain calls.
URL_PATTERN.lastIndex = 0;
