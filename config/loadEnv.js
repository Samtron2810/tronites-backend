import dotenv from "dotenv";

// Populates process.env from .env before any other local module runs.
//
// This file must stay the very first import in index.js. ES module
// imports are evaluated in source order, and each import's full
// dependency tree is fully evaluated before the next import runs —
// verified empirically. utils/redis.js, socket/socket.js,
// queues/imageUploadQueue.js, and queues/imageUploadWorker.js all read
// process.env.REDIS_URL at their own top level (not inside a function),
// so previously — with dotenv.config() called as a plain statement after
// those had already been imported — they always saw an undefined
// REDIS_URL locally and silently fell back to redis://localhost:6379.
// Making dotenv.config() run inside the first-imported module fixes this
// for all of them at once, with no changes needed in those files.
dotenv.config();

const required = ["MONGO_URI", "JWT_SECRET"];
const missing = required.filter((key) => !process.env[key]);

if (missing.length > 0) {
  console.error(
    `Missing required environment variable(s): ${missing.join(", ")}. Set these before starting the server.`,
  );
  process.exit(1);
}

if (!process.env.REDIS_URL) {
  console.warn(
    "REDIS_URL is not set — Redis is optional, so the server will start, but caching, shared rate limiting, presence, and the image-upload queue will all run in local fallback mode.",
  );
}
