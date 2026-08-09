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

// Shared upload-and-wait helper, used by both createPost and
// updateProfilePicture. Enqueues the job, waits for it to finish, and
// throws a clearly-tagged error the controller can turn into a specific
// HTTP response instead of a generic 500.
//
// Two distinct failure shapes:
//   - UPLOAD_LOST: the job disappeared before finishing — most likely
//     Redis evicted it under memory pressure (see the eviction-policy
//     warning logged on startup). Nothing to retry; the data is gone.
//   - UPLOAD_FAILED: the job ran and failed for a real reason (bad
//     image, Cloudinary error, etc) after BullMQ's 3 built-in retries.
export const uploadImageAndWait = async (jobName, jobData, timeoutMs = 30000) => {
  const job = await imageUploadQueue.add(jobName, jobData);

  try {
    const result = await job.waitUntilFinished(imageUploadQueueEvents, timeoutMs);
    return result;
  } catch (err) {
    const stillExists = await imageUploadQueue.getJob(job.id);

    if (!stillExists && !err.message?.includes("failed")) {
      console.error(
        `Image upload job ${job.id} vanished before completing — likely evicted from Redis under memory pressure.`,
      );
      const lostError = new Error("Image upload failed — please try again.");
      lostError.code = "UPLOAD_LOST";
      lostError.httpStatus = 503;
      throw lostError;
    }

    console.error(`Image upload job ${job.id} failed:`, err.message);
    const failedError = new Error("Image upload failed — please try again.");
    failedError.code = "UPLOAD_FAILED";
    failedError.httpStatus = 502;
    throw failedError;
  }
};
