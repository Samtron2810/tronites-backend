import { z } from "zod";

// ─── Auth ───────────────────────────────────────────────────────────────────

export const registerSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, "Name must be at least 2 characters")
    .max(50, "Name must be at most 50 characters"),
  email: z.string().trim().email("Invalid email address"),
  password: z
    .string()
    .min(6, "Password must be at least 6 characters")
    .max(128, "Password too long"),
});

export const loginSchema = z.object({
  email: z.string().trim().email("Invalid email address"),
  password: z.string().min(1, "Password is required"),
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

// ─── Comment ────────────────────────────────────────────────────────────────

export const createCommentSchema = z.object({
  text: z
    .string()
    .trim()
    .min(1, "Comment cannot be empty")
    .max(280, "Comment must be at most 280 characters"),
});

// ─── Message ────────────────────────────────────────────────────────────────

export const sendMessageSchema = z.object({
  text: z.string().trim().max(1000, "Message too long").optional().default(""),
});

// ─── User ───────────────────────────────────────────────────────────────────

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

// ─── Middleware factory ──────────────────────────────────────────────────────

export const validate = (schema) => (req, res, next) => {
  const result = schema.safeParse(req.body);
  if (!result.success) {
    const errors = result.error.issues.map((issue) => ({
      field: issue.path.join("."),
      message: issue.message,
    }));
    return res.status(400).json({ message: "Validation failed", errors });
  }
  req.body = result.data;
  next();
};

export const validateQuery = (schema) => (req, res, next) => {
  const result = schema.safeParse(req.query);
  if (!result.success) {
    const errors = result.error.issues.map((issue) => ({
      field: issue.path.join("."),
      message: issue.message,
    }));
    return res.status(400).json({ message: "Validation failed", errors });
  }
  // Merge parsed values into req.query (cannot reassign due to read-only getter)
  Object.assign(req.query, result.data);
  next();
};
