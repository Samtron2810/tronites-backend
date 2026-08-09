import { Queue, QueueEvents } from "bullmq";

// Dedicated Redis connection for BullMQ. Cannot reuse the app's normal
// redisClient (from utils/redis.js) or the socket adapter's pub/sub
// clients — BullMQ needs its own connection with specific options
// (maxRetriesPerRequest: null) and manages its own commands internally.
const connection = {
  url: process.env.REDIS_URL || "redis://localhost:6379",
};

// Why a queue at all: cloudinary.uploader.upload() used to be awaited
// directly inside the request handler. That means the request — and the
// single Node event loop handling ALL requests — sits blocked until
// Cloudinary responds. Under a burst of uploads (many users posting
// images at once), requests pile up waiting on network I/O to a third
// party, and everything else on that instance slows down with them.
//
// A queue moves the actual upload work to a separate worker process.
// The API request enqueues a job and awaits its completion event
// (still returns the URL to the client, same response contract as
// before) but the heavy lifting happens in the worker, and multiple
// uploads can be processed with controlled concurrency instead of each
// blocking a request handler.
export const imageUploadQueue = new Queue("image-upload", {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 2000,
    },
    // Auto-clean completed/failed jobs so Redis doesn't fill up with
    // job history over time.
    removeOnComplete: { age: 3600 }, // keep for 1 hour then drop
    removeOnFail: { age: 86400 }, // keep failures for 1 day (debugging)
  },
});

// QueueEvents listens to Redis pub/sub for job lifecycle events
// (completed/failed). Required for job.waitUntilFinished() to resolve —
// without it, the promise returned by that call never settles.
export const imageUploadQueueEvents = new QueueEvents("image-upload", {
  connection,
});

imageUploadQueue.on("error", (err) => {
  console.error("Image upload queue error:", err.message);
});

imageUploadQueueEvents.on("error", (err) => {
  console.error("Image upload queue events error:", err.message);
});
