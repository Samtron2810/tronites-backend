import { Queue } from "bullmq";
import { isRedisReady } from "../utils/redis.js";

const connection = {
  url: process.env.REDIS_URL || "redis://localhost:6379",
};

// Unlike imageUploadQueue (enqueue-and-wait, ~seconds), video processing
// on Cloudinary — transcoding, eager-generating the trimmed/capped
// variant, thumbnail extraction — routinely takes tens of seconds to a
// few minutes. Blocking an HTTP request handler for that long isn't
// viable (client timeouts, tied-up connections under any real upload
// volume), so this queue is fire-and-forget: the job uploads the raw
// video and kicks off Cloudinary's async processing with a
// notification_url, then returns immediately. The post is created with
// status "processing" right away; postWebhookController flips it to
// "ready"/"failed" when Cloudinary calls back.
export const videoUploadQueue = new Queue("video-upload", {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: { age: 3600 },
    removeOnFail: { age: 86400 },
  },
});

videoUploadQueue.on("error", (err) => {
  console.error("Video upload queue error:", err.message);
});

// No direct-upload fallback like imageUploadQueue's uploadImageDirect:
// a video upload without a queue would mean the API process itself
// holds the (large) file in memory for the full Cloudinary processing
// duration, defeating the entire point of queuing it. If Redis is down,
// video posting is unavailable rather than degraded — surfaced to the
// controller as a clear error instead of silently blocking a request
// for minutes.
export const enqueueVideoUpload = async (jobData) => {
  if (!isRedisReady()) {
    const err = new Error(
      "Video upload is temporarily unavailable. Please try again shortly.",
    );
    err.code = "VIDEO_QUEUE_UNAVAILABLE";
    err.httpStatus = 503;
    throw err;
  }

  try {
    return await videoUploadQueue.add("video-upload", jobData);
  } catch (err) {
    console.error("Video upload enqueue failed:", err.message);
    const queueError = new Error(
      "Video upload is temporarily unavailable. Please try again shortly.",
    );
    queueError.code = "VIDEO_QUEUE_UNAVAILABLE";
    queueError.httpStatus = 503;
    throw queueError;
  }
};
