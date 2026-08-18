import "./config/loadEnv.js";

import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import mongoose from "mongoose";

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

// Trust the first hop (hosting platform's reverse proxy) so req.ip and
// X-Forwarded-For are read correctly — required for express-rate-limit
// to key limits per real client instead of erroring or bucketing everyone together.
app.set("trust proxy", 1);

app.use(express.json({ limit: "20mb" }));
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
      console.log("Image upload queue/worker closed");

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

startServer();
