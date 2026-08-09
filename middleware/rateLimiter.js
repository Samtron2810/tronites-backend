import rateLimit from "express-rate-limit";
import { RedisStore } from "rate-limit-redis";
import redisClient from "../utils/redis.js";

// express-rate-limit defaults to an in-memory store — each counts requests
// only for the process it's running in. With one instance that's fine, but
// the moment you run 2+ instances behind a load balancer, a client's
// requests get split across processes and each one thinks the client is
// under the limit. A shared Redis store makes the count correct no matter
// how many instances are running.
//
// Falls back to the default in-memory store if Redis is unavailable, so
// rate limiting still works (per-instance) rather than crashing requests.
const makeStore = (prefix) => {
  try {
    return new RedisStore({
      sendCommand: (...args) => redisClient.sendCommand(args),
      prefix,
    });
  } catch (err) {
    console.warn(`Redis rate-limit store unavailable for "${prefix}", falling back to in-memory:`, err.message);
    return undefined;
  }
};

// General API limiter — 100 requests per 15 minutes (only for write operations)
// GET requests are skipped to allow unlimited navigation
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  message: {
    message: "Too many requests, please try again later.",
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === "GET",
  store: makeStore("rl:api:"),
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
  store: makeStore("rl:auth:"),
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
  store: makeStore("rl:post:"),
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
  store: makeStore("rl:comment:"),
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
  store: makeStore("rl:message:"),
});
