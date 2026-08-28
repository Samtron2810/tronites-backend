import { z } from "zod";

// ─── Auth ───────────────────────────────────────────────────────────────────

// Unicode letters/marks, may contain internal apostrophes, hyphens, or
// spaces (O'Brien, Mary-Jane, Adéọlá, Chukwuemeka N.) but must start with
// a letter. `u` flag required for \p{L}/\p{M} property escapes.
const NAME_PATTERN = /^[\p{L}\p{M}][\p{L}\p{M}' -]*$/u;

export const registerSchema = z.object({
  firstName: z
    .string()
    .trim()
    .min(2, "First name must be at least 2 characters")
    .max(30, "First name must be at most 30 characters")
    .regex(NAME_PATTERN, "First name contains invalid characters"),
  lastName: z
    .string()
    .trim()
    .min(2, "Last name must be at least 2 characters")
    .max(30, "Last name must be at most 30 characters")
    .regex(NAME_PATTERN, "Last name contains invalid characters"),
  email: z.string().trim().toLowerCase().email("Invalid email address"),
  password: z
    .string()
    .min(10, "Password must be at least 10 characters")
    .max(128, "Password too long"),
});

export const loginSchema = z.object({
  identifier: z.string().trim().min(1, "Email or username is required"),
  password: z.string().min(1, "Password is required"),
});

// Reuses the same "just needs to be non-empty" shape as loginSchema —
// the actual password correctness check happens against the stored hash
// in deleteMyAccount, this only guards against a missing/empty field
// before that comparison runs.
export const deleteAccountSchema = z.object({
  password: z.string().min(1, "Password is required"),
});

// generateChallengeId() (utils/otp.js) is crypto.randomBytes(24) encoded
// as base64url — always exactly 32 characters from the URL-safe alphabet,
// no padding. Matching that shape here instead of "any non-empty string"
// rejects malformed/guessed IDs before they ever reach a database query.
const CHALLENGE_ID_PATTERN = /^[A-Za-z0-9_-]{32}$/;

export const validateOtpSchema = z.object({
  challengeId: z
    .string()
    .trim()
    .regex(CHALLENGE_ID_PATTERN, "Invalid challenge ID"),
  otp: z.string().regex(/^\d{6}$/, "OTP must be 6 digits"),
});

export const resendOtpSchema = z.object({
  challengeId: z
    .string()
    .trim()
    .regex(CHALLENGE_ID_PATTERN, "Invalid challenge ID"),
});

// Forgot-password request. The response is intentionally neutral whether
// or not the email exists (see forgotPassword in authController.js), so
// this schema only needs to ensure the input is a well-formed address.
export const forgotPasswordSchema = z.object({
  email: z.string().trim().toLowerCase().email("Invalid email address"),
});

// Reset-password request: the challengeId + OTP come straight from the
// existing verify flow (same shape as validateOtpSchema), and the new
// password matches the registration strength rules — min 10 chars.
export const resetPasswordSchema = z.object({
  challengeId: z
    .string()
    .trim()
    .regex(CHALLENGE_ID_PATTERN, "Invalid challenge ID"),
  otp: z.string().regex(/^\d{6}$/, "OTP must be 6 digits"),
  newPassword: z
    .string()
    .min(10, "Password must be at least 10 characters")
    .max(128, "Password too long"),
});

// ─── Post ───────────────────────────────────────────────────────────────────

// Post audience — kept in sync with the Post model enum and
// services/postVisibilityService.js (stylistically mirrors the manually
// synced POST_EDIT_COOLDOWN_MS constants used elsewhere).
const POST_PRIVACY_VALUES = ["public", "followers", "only-me"];

export const createPostSchema = z.object({
  text: z
    .string()
    .trim()
    .max(280, "Post text must be at most 280 characters")
    .optional()
    .default(""),
  // Signed browser upload: images arrive as Cloudinary URLs.
  images: z
    .array(z.string().url("Invalid image URL"))
    .max(4, "Max 4 images per post")
    .optional()
    .default([]),
  // Post audience — who can see this post. Optional; absent defaults
  // to "public" server-side.
  privacy: z.enum(POST_PRIVACY_VALUES).optional().default("public"),
});

// Signed browser upload: request a signature for image uploads.
export const createImageSignatureSchema = z.object({
  count: z.number().int().min(1).max(4).optional().default(1),
});

// Signed browser upload: request a signature for a video upload. No body
// needed — the post is created separately after the upload completes
// (see createVideoPostSchema), so this is just an empty-object check.
export const createVideoSignatureSchema = z.object({});

// Create a video post from an already-uploaded Cloudinary asset (the
// custom uploader flow — see controllers/postController.js). The URL/
// publicId are re-validated against our cloud + folder in the controller;
// this schema only enforces shape.
export const createVideoPostSchema = z.object({
  text: z
    .string()
    .trim()
    .max(280, "Post text must be at most 280 characters")
    .optional()
    .default(""),
  video: z.object({
    publicId: z.string().trim().min(1, "Missing video publicId").max(255),
    url: z.string().url("Invalid video URL"),
    durationSeconds: z.number().positive().max(600).nullable().optional(),
  }),
  // Post audience — same as createPostSchema.
  privacy: z.enum(POST_PRIVACY_VALUES).optional().default("public"),
});

// Edit is text-only (images are fixed after posting). Empty text is
// allowed here the same way it's allowed on create — an image post can
// have no caption — the controller re-checks that text+images aren't
// both empty using the post's *existing* images, since edit can't add
// images to a text-only post.
export const editPostSchema = z.object({
  text: z
    .string()
    .trim()
    .max(280, "Post text must be at most 280 characters")
    .optional()
    .default(""),
});

// Quote post — the quoter's own caption. Can be empty (a bare "look at
// this" quote with no added commentary is a normal Twitter/X pattern),
// same as an image-only post being allowed empty text.
export const createQuoteSchema = z.object({
  text: z
    .string()
    .trim()
    .max(280, "Quote text must be at most 280 characters")
    .optional()
    .default(""),
});

// ─── Comment ────────────────────────────────────────────────────────────────

export const createCommentSchema = z.object({
  text: z
    .string()
    .trim()
    .min(1, "Comment cannot be empty")
    .max(280, "Comment must be at most 280 characters"),
  parentCommentId: z
    .string()
    .regex(/^[a-f0-9]{24}$/i, "Invalid comment id")
    .optional(),
});

// ─── Message ────────────────────────────────────────────────────────────────

export const sendMessageSchema = z.object({
  text: z.string().trim().max(1000, "Message too long").optional().default(""),
});

// Signed browser upload: request a signature for a chat-video upload. No
// body needed — the message is created separately after the upload completes
// (see sendVideoMessageSchema), so this is just an empty-object check.
export const messageVideoSignatureSchema = z.object({});

// Create a video message from an already-uploaded Cloudinary asset (the
// custom uploader flow — see messageController.sendVideoMessage). The
// URL/publicId are re-validated against our cloud + folder in the controller;
// this schema only enforces shape.
export const sendVideoMessageSchema = z.object({
  text: z
    .string()
    .trim()
    .max(1000, "Message too long")
    .optional()
    .default(""),
  video: z.object({
    publicId: z.string().trim().min(1, "Missing video publicId").max(255),
    url: z.string().url("Invalid video URL"),
    durationSeconds: z.number().positive().max(600).nullable().optional(),
  }),
});

// ─── User ───────────────────────────────────────────────────────────────────

export const setUsernameSchema = z.object({
  username: z
    .string()
    .trim()
    .toLowerCase()
    .min(3, "Username must be at least 3 characters")
    .max(20, "Username must be at most 20 characters")
    .regex(
      /^[a-z0-9_]+$/,
      "Username can only contain lowercase letters, numbers, and underscores",
    ),
});

// Reuses NAME_PATTERN declared above (shared with signup's
// firstName/lastName split validators).
export const updateNameSchema = z.object({
  firstName: z
    .string()
    .trim()
    .min(1, "First name is required")
    .max(30, "First name must be at most 30 characters")
    .regex(NAME_PATTERN, "First name can only contain letters"),
  lastName: z
    .string()
    .trim()
    .min(1, "Last name is required")
    .max(30, "Last name must be at most 30 characters")
    .regex(NAME_PATTERN, "Last name can only contain letters"),
});

export const updateBioSchema = z.object({
  bio: z
    .string()
    .trim()
    .max(150, "Bio must be at most 150 characters")
    .optional()
    .default(""),
});

export const searchQuerySchema = z.object({
  q: z.string().trim().optional().default(""),
});

// ─── Pagination ─────────────────────────────────────────────────────────────

export const paginationSchema = z.object({
  page: z
    .string()
    .optional()
    .default("1")
    .transform((val) => {
      const num = parseInt(val, 10);
      return isNaN(num) || num < 1 ? 1 : num;
    }),
  limit: z
    .string()
    .optional()
    .default("10")
    .transform((val) => {
      const num = parseInt(val, 10);
      if (isNaN(num) || num < 1) return 10;
      if (num > 50) return 50;
      return num;
    }),
});

// ─── Report / Mute ──────────────────────────────────────────────────────────

const OBJECT_ID_PATTERN = /^[a-f0-9]{24}$/i;

export const createReportSchema = z.object({
  targetType: z.enum(["user", "post", "comment", "message"]),
  targetId: z.string().regex(OBJECT_ID_PATTERN, "Invalid target id"),
  reason: z.enum([
    "spam",
    "harassment",
    "hate_speech",
    "violence",
    "nudity_sexual_content",
    "self_harm",
    "impersonation",
    "misinformation",
    "other",
  ]),
  details: z.string().trim().max(500).optional().default(""),
});

export const resolveReportSchema = z.object({
  status: z.enum(["actioned", "dismissed"]),
  note: z.string().trim().max(500).optional().default(""),
  // Phase 1: resolving as "actioned" may also soft-remove the reported
  // post/comment/message. Guarded again in reportService (only valid
  // alongside status:"actioned") so a dismissed report can't take
  // content down.
  removeContent: z.boolean().optional().default(false),
});

export const presenceVisibilitySchema = z.object({
  presenceVisibility: z.enum(["everyone", "followers", "nobody"]),
});

// ─── Admin ──────────────────────────────────────────────────────────────────

export const updateRoleSchema = z.object({
  role: z.enum(["user", "moderator", "admin"]),
});

// Phase 2 account restrictions. `until` arrives as an ISO-ish string from
// the datetime picker — parsed to a real Date here so controllers receive
// what Mongoose expects; "must be in the future" is enforced in the
// controller against server time (client clocks lie).
export const suspendUserSchema = z.object({
  until: z
    .string()
    .refine((v) => !Number.isNaN(Date.parse(v)), "Invalid suspension date")
    .transform((v) => new Date(v)),
  reason: z.string().trim().max(500).optional().default(""),
});

export const banUserSchema = z.object({
  reason: z.string().trim().max(500).optional().default(""),
});

// Phase 4 warnings/strikes. reason is REQUIRED — the warned user sees it
// verbatim in their notification. reportId optionally ties the strike to
// the queue item that prompted it; shape-checked in the controller with
// mongoose.isValidObjectId so a garbage id is ignored cleanly rather than
// throwing a cast error mid-write.
export const warnUserSchema = z.object({
  reason: z.string().trim().min(1).max(500),
  reportId: z.string().optional(),
});

// Phase 5 — granular permission editing. Whole-array replacement (not
// add/remove deltas): simpler client, and the confirm modal always sends
// the full intended set. Enum mirrors models/User.js PERMISSIONS — keep
// both in sync. manage_roles is accepted here for forward-compat but no
// runtime gate consumes it yet (role routes stay requireAdmin).
export const updatePermissionsSchema = z.object({
  permissions: z
    .array(
      z.enum([
        "manage_reports",
        "manage_users",
        "manage_content",
        "view_audit_log",
        "manage_roles",
      ]),
    )
    .max(5),
});

// Phase 6 -- bulk restriction from the admin panel selection bar. Mirrors
// the single-user suspend/ban/unrestrict contract: one batch of userIds,
// action in suspend|ban|unrestrict (no role escalation), `until` required
// only for suspend, and an optional shared reason. ids are trimmed non-empty
// strings here; the controller drops malformed ObjectIds so one bad id can
// not poison the whole batch, and the controller expects the size cap.
export const bulkUsersSchema = z
  .object({
    userIds: z
      .array(z.string().trim().min(1))
      .min(1, "Select at least one user")
      .max(100, "Bulk action is capped at 100 users"),
    action: z.enum(["suspend", "ban", "unrestrict"]),
    until: z
      .string()
      .refine((v) => !Number.isNaN(Date.parse(v)), "Invalid suspension date")
      .transform((v) => new Date(v))
      .optional(),
    reason: z.string().trim().max(500).optional().default(""),
  })
  .superRefine((data, ctx) => {
    if (data.action === "suspend" && !data.until) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["until"],
        message: "Suspension requires a date",
      });
    }
  });

// ─── Middleware factory ──────────────────────────────────────────────────────

export const validate = (schema) => (req, res, next) => {
  // Default to {} for bodyless requests: axios doesn't send a
  // Content-Type/body at all when a POST has no data, so express.json()
  // never runs and req.body stays undefined — z.object() schemas would
  // otherwise reject it with "expected object, received undefined".
  const result = schema.safeParse(req.body ?? {});
  if (!result.success) {
    const firstError = result.error.issues[0];
    const errors = result.error.issues.map((issue) => ({
      field: issue.path.join("."),
      message: issue.message,
    }));
    return res.status(400).json({ message: firstError.message, errors });
  }
  req.body = result.data;
  next();
};

export const validateQuery = (schema) => (req, res, next) => {
  const result = schema.safeParse(req.query);
  if (!result.success) {
    const firstError = result.error.issues[0];
    const errors = result.error.issues.map((issue) => ({
      field: issue.path.join("."),
      message: issue.message,
    }));
    return res.status(400).json({ message: firstError.message, errors });
  }
  // Merge parsed values into req.query (cannot reassign due to read-only getter)
  Object.assign(req.query, result.data);
  next();
};
