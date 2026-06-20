import rateLimit from "express-rate-limit";

// General API limiter — 100 requests per 15 minutes
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  message: {
    message: "Too many requests, please try again later.",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Auth limiter (register/login) — 10 requests per 15 minutes
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: {
    message: "Too many authentication attempts, please try again later.",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Post creation limiter — 30 posts per hour
export const postLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 30,
  message: {
    message: "Too many posts created, please slow down.",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Comment limiter — 60 comments per hour
export const commentLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 60,
  message: {
    message: "Too many comments, please slow down.",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Message limiter — 100 messages per hour
export const messageLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 100,
  message: {
    message: "Too many messages, please slow down.",
  },
  standardHeaders: true,
  legacyHeaders: false,
});
