import "./config/loadEnv.js";

import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import mongoose from "mongoose";
import helmet from "helmet";

import connectDB from "./config/db.js";
import getAllowedOrigins from "./config/allowedOrigins.js";
//routes importing
import authRoutes from "./routes/authRoutes.js";
import postRoutes from "./routes/postRoutes.js";
import commentRoutes from "./routes/commentRoutes.js";
import userRoutes from "./routes/userRoutes.js";
import notificationRoutes from "./routes/notificationRoutes.js";
import messageRoutes from "./routes/messageRoutes.js";
import reportRoutes from "./routes/reportRoutes.js";
import adminRoutes from "./routes/adminRoutes.js";
import searchRoutes from "./routes/searchRoutes.js";
import webhookRoutes from "./routes/webhookRoutes.js";
import {
  app,
  server,
  io,
  initSocketRedisAdapter,
  isSocketAdapterReady,
  disconnectSocketRedis,
} from "./socket/socket.js";
import { apiLimiter } from "./middleware/rateLimiter.js";
import csrfProtection from "./middleware/csrfProtection.js";
import { startImageUploadWorker } from "./queues/imageUploadWorker.js";
import {
  imageUploadQueue,
  imageUploadQueueEvents,
} from "./queues/imageUploadQueue.js";
import { connectRedis, isRedisReady, disconnectRedis } from "./utils/redis.js";
import errorHandler from "./middleware/errorHandler.js";
import { cleanupAbandonedVideoShells } from "./jobs/cleanupAbandonedVideoShells.js";
import { purgeDeletedAccounts } from "./jobs/purgeDeletedAccounts.js";
import { flagRepeatOffenders } from "./jobs/flagRepeatOffenders.js";
import { computeForYouSignals } from "./jobs/computeForYouSignals.js";

// Trust the first hop (hosting platform's reverse proxy) so req.ip and
// X-Forwarded-For are read correctly — required for express-rate-limit
// to key limits per real client instead of erroring or bucketing everyone together.
app.set("trust proxy", 1);

// Security response headers — this is a JSON API with no server-rendered
// HTML, so helmet's default CSP (aimed at browser-rendered pages) isn't
// especially meaningful here; contentSecurityPolicy is disabled to avoid
// shipping a policy that doesn't apply to anything this server returns.
// The headers that do matter for an API — X-Content-Type-Options (stops
// browsers from MIME-sniffing a JSON response as something executable),
// Strict-Transport-Security, X-Frame-Options, and the rest of helmet's
// non-CSP defaults — still apply.
app.use(helmet({ contentSecurityPolicy: false }));

// Mounted before express.json() (below) and before CSRF/rate-limiting —
// two reasons: (1) whichever body parser touches the request stream
// first wins, and this route needs the exact raw bytes for Cloudinary's
// signature check (see webhookController.js), not JSON already parsed
// by the app-wide middleware; (2) Cloudinary's server calls this
// directly, not a browser session, so the SameSite-cookie-based CSRF
// defense doesn't apply and would only ever reject it. The handler
// itself verifies Cloudinary's signature, which is this route's actual
// authentication.
app.use("/api/webhooks", webhookRoutes);

// Media (images/video) goes straight to Cloudinary from the client, not
// through this JSON body — the API only ever receives text, URLs, and
// metadata. 1mb is generous headroom for that; 20mb needlessly widened
// the DoS surface since a large JSON body is expensive to parse before
// rate limiting even gets a chance to reject it.
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "20mb" }));
app.use(cookieParser());

app.use(
  cors({
    origin: getAllowedOrigins(),
    credentials: true,
  }),
);

// CSRF defense: cookie auth requires SameSite=None across our two origins
// (Vercel frontend, Render backend), which by itself carries no CSRF
// protection, and CORS doesn't cover the gap either — see
// middleware/csrfProtection.js for why. Placed before the rate limiter so
// a rejected cross-site request doesn't spend a rate-limit slot.
app.use("/api", csrfProtection);

// Global rate limiter
app.use("/api", apiLimiter);

//routes usage
app.use("/api/auth", authRoutes);
app.use("/api/posts", postRoutes);
app.use("/api/comments", commentRoutes);
app.use("/api/users", userRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/messages", messageRoutes);
app.use("/api/reports", reportRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/search", searchRoutes);
app.get("/", (req, res) => {
  res.send("API Running...");
});
// Liveness: process is up and handling requests. Never checks dependencies
// — a Redis or Mongo outage should show up as "not ready", not "not
// alive", so an orchestrator doesn't kill a process that's correctly
// running in degraded fallback mode.
app.get("/health/live", (req, res) => {
  res.status(200).json({ status: "ok" });
});

// Readiness: Mongo is the only hard requirement — nothing works without
// it. Redis is optional by design (caching, rate limiting, presence, and
// the image-upload queue all have in-memory/direct fallbacks), so it's
// reported for visibility but never fails readiness on its own.
app.get("/health/ready", (req, res) => {
  const mongoOk = mongoose.connection.readyState === 1;
  const redisOk = isRedisReady();
  const socketAdapterOk = isSocketAdapterReady();

  res.status(mongoOk ? 200 : 503).json({
    status: mongoOk ? (redisOk ? "ok" : "degraded") : "unavailable",
    mongo: mongoOk ? "connected" : "disconnected",
    redis: redisOk ? "connected" : "fallback",
    socketAdapter: socketAdapterOk ? "connected" : "fallback",
  });
});

// Unmatched route — must come after every real route above, before the
// error handler.
app.use((req, res) => {
  res.status(404).json({ message: "Route not found." });
});

// Must be registered last, after every route and other middleware —
// Express only routes to an error handler (4-arg signature) when
// something upstream calls next(err) or an asyncHandler-wrapped promise
// rejects.
app.use(errorHandler);

const PORT = process.env.PORT || 5000;

const startServer = async () => {
  // Sequenced so each dependency is confirmed (or has safely fallen back)
  // before the next step relies on it, and the HTTP server only starts
  // accepting traffic once this settles. connectDB() exits the process on
  // failure (Mongo is a hard requirement); connectRedis() and
  // initSocketRedisAdapter() are both internally timeout-bounded and never
  // throw, so Redis being unreachable degrades instead of blocking boot.
  await connectDB();
  await connectRedis();
  await initSocketRedisAdapter();

  const worker = startImageUploadWorker();

  // Fallback cleanup for video post shells abandoned before the
  // Cloudinary Upload Widget's close/error/success callback ever fires
  // (crash, closed tab, lost network) — see jobs/cleanupAbandonedVideoShells.js.
  // Runs once at boot (catches anything abandoned while the server was
  // down) and then hourly.
  const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
  cleanupAbandonedVideoShells();
  const cleanupInterval = setInterval(
    cleanupAbandonedVideoShells,
    CLEANUP_INTERVAL_MS,
  );

  // Hard-deletes accounts whose 30-day soft-delete grace period has
  // passed — see jobs/purgeDeletedAccounts.js. Same run-at-boot-then-
  // hourly cadence as the video shell cleanup above; hourly is frequent
  // enough that no account sits meaningfully longer than its grace
  // period without also being a very cheap no-op sweep on every run
  // where nothing is due (a single indexed User.find, no writes).
  purgeDeletedAccounts();
  const purgeInterval = setInterval(purgeDeletedAccounts, CLEANUP_INTERVAL_MS);

  // Phase 6 — raises a reported account's open reports to high priority
  // once they cross REPEAT_OFFENDER_THRESHOLD within 24h, so pile-ups
  // surface at the top of the moderation queue proactively — see
  // jobs/flagRepeatOffenders.js. Same boot-then-hourly cadence as the
  // two sweeps above; the sweep itself is idempotent (only
  // priority:"normal" rows match), so hourly is cheap and safe.
  flagRepeatOffenders();
  const offenderInterval = setInterval(
    flagRepeatOffenders,
    CLEANUP_INTERVAL_MS,
  );

  // For You ranking maintenance — followersCount reconciliation +
  // credibleRatio recompute (jobs/computeForYouSignals.js). Runs less
  // often than the hourly sweeps above: credibleRatio is intentionally
  // a slow-moving signal (TRONITES_RANKING_FAIRNESS.md calls it
  // "nightly"), and follower-count drift only matters for ranking
  // precision, not correctness of any user-facing count display.
  const FOR_YOU_SIGNALS_INTERVAL_MS = 24 * 60 * 60 * 1000;
  computeForYouSignals();
  const forYouSignalsInterval = setInterval(
    computeForYouSignals,
    FOR_YOU_SIGNALS_INTERVAL_MS,
  );

  // io is attached to this exact server instance (see socket/socket.js) —
  // must listen on `server`, not app.listen() (which would silently spin
  // up a second, unrelated http.Server and leave Socket.IO unreachable).
  server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received — shutting down gracefully...`);

    const forceExit = setTimeout(() => {
      console.error("Graceful shutdown timed out — forcing exit.");
      process.exit(1);
    }, 10000);
    forceExit.unref();

    try {
      clearInterval(cleanupInterval);
      clearInterval(purgeInterval);
      clearInterval(offenderInterval);
      clearInterval(forYouSignalsInterval);

      // Stops accepting new connections, disconnects existing sockets, and
      // closes the underlying HTTP server (io.close() owns both — see
      // socket/socket.js).
      await io.close();
      console.log("HTTP server and Socket.IO closed");

      await Promise.allSettled([
        worker ? worker.close() : Promise.resolve(),
        imageUploadQueue.close(),
        imageUploadQueueEvents.close(),
      ]);
      console.log("Image upload queue and worker closed");

      await disconnectSocketRedis();
      console.log("Socket Redis adapter disconnected");

      await disconnectRedis();
      console.log("Redis client disconnected");

      await mongoose.connection.close();
      console.log("MongoDB connection closed");
    } catch (err) {
      console.error("Error during shutdown:", err.message);
    } finally {
      clearTimeout(forceExit);
      process.exit(0);
    }
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
};

// Only auto-starts outside of tests — tests import `app` directly (see
// tests/setup.js) and manage their own isolated DB connection via
// mongodb-memory-server, so they don't want this module's side effects:
// a real Mongo/Redis connection attempt, BullMQ workers, signal
// handlers, or a listening HTTP server.
if (process.env.NODE_ENV !== "test") {
  startServer();
}

export { app };
