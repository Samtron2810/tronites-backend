import { Worker } from "bullmq";
import cloudinary from "../utils/cloudinary.js";
import Post from "../models/Post.js";
import { emitToUser, emitToFollowersOf } from "../socket/socket.js";
import { invalidateFeedCache, invalidateCache } from "../utils/redis.js";

const connection = {
  url: process.env.REDIS_URL || "redis://localhost:6379",
};

// Cloudinary's `notification_url` callback needs a publicly reachable
// URL — localhost works for nothing but local testing with a tunnel
// (ngrok etc). Required for video specifically because that's the only
// place this codebase relies on Cloudinary calling back in; every other
// upload (images) is synchronous and doesn't need one.
const BACKEND_PUBLIC_URL = process.env.BACKEND_PUBLIC_URL;

export const startVideoUploadWorker = () => {
  if (!BACKEND_PUBLIC_URL) {
    console.warn(
      "BACKEND_PUBLIC_URL is not set — video upload worker not started. " +
        "Video posting will fail until it's configured (needed for Cloudinary's processing webhook).",
    );
    return null;
  }

  try {
    const worker = new Worker(
      "video-upload",
      async (job) => {
        const { base64Data, postId, maxDurationSeconds } = job.data;

        // eager: async-generates the actual playable variant — trimmed
        // to maxDurationSeconds, transcoded to a broadly-compatible
        // mp4/h264 — separate from the raw uploaded asset. `eager_async:
        // true` is what makes this non-blocking on Cloudinary's side;
        // the eager array's transformation completing is what triggers
        // the notification_url callback (not the initial upload
        // response, which just confirms the raw file was received).
        const result = await cloudinary.uploader.upload(base64Data, {
          resource_type: "video",
          folder: "tronites_videos",
          eager: [
            {
              start_offset: "0",
              duration: String(maxDurationSeconds),
              format: "mp4",
              video_codec: "h264",
              quality: "auto",
            },
          ],
          eager_async: true,
          notification_url: `${BACKEND_PUBLIC_URL}/api/webhooks/cloudinary`,
          // Round-trips postId through Cloudinary's context metadata so
          // the webhook handler knows which Post document to update —
          // Cloudinary's callback payload identifies the asset by
          // public_id, not by any ID of ours, so this is the link back.
          context: `postId=${postId}`,
        });

        // The raw (untrimmed, unprocessed) upload succeeded here, but
        // the actual playable/ready video isn't available yet — that
        // arrives via the webhook once `eager` finishes. Store what we
        // have now so the webhook has a publicId to match against, but
        // leave status as "processing".
        await Post.updateOne(
          { _id: postId },
          {
            $set: {
              "video.publicId": result.public_id,
              "video.status": "processing",
            },
          },
        );

        return { publicId: result.public_id };
      },
      {
        connection,
        // Lower concurrency than the image worker (5) — videos are much
        // larger payloads; a handful running at once is enough to avoid
        // a backlog without saturating outbound bandwidth.
        concurrency: 2,
      },
    );

    worker.on("failed", async (job, err) => {
      console.error(`Video upload job ${job?.id} failed:`, err.message);
      const postId = job?.data?.postId;
      if (!postId) return;

      try {
        const post = await Post.findOneAndUpdate(
          { _id: postId },
          { $set: { "video.status": "failed" } },
          { returnDocument: "after" },
        );
        if (!post) return;

        invalidateFeedCache(post.user);
        invalidateCache(`profile-posts:${post.user}:*`);

        const failPayload = { postId: post._id, video: { status: "failed" } };
        emitToUser(post.user, "videoFailed", failPayload);
        emitToFollowersOf(post.user, "videoFailed", failPayload);
      } catch (updateErr) {
        console.error(
          `Failed to mark post ${postId} video as failed:`,
          updateErr.message,
        );
      }
    });

    worker.on("error", (err) => {
      console.error("Video upload worker error:", err.message);
    });

    console.log("Video upload worker started");
    return worker;
  } catch (err) {
    console.warn("Video upload worker failed to start:", err.message);
    return null;
  }
};
