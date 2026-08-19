import { z } from "zod";

// ─── Auth ───────────────────────────────────────────────────────────────────

export const registerSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, "Name must be at least 2 characters")
    .max(50, "Name must be at most 50 characters"),
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

export const createPostSchema = z.object({
  text: z
    .string()
    .trim()
    .max(280, "Post text must be at most 280 characters")
    .optional()
    .default(""),
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
});

export const presenceVisibilitySchema = z.object({
  presenceVisibility: z.enum(["everyone", "followers", "nobody"]),
});

// ─── Admin ──────────────────────────────────────────────────────────────────

export const updateRoleSchema = z.object({
  role: z.enum(["user", "moderator", "admin"]),
});

// ─── Middleware factory ──────────────────────────────────────────────────────

export const validate = (schema) => (req, res, next) => {
  const result = schema.safeParse(req.body);
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
