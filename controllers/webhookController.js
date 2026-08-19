import cloudinary from "../utils/cloudinary.js";
import Post from "../models/Post.js";
import { emitToUser, emitToFollowersOf } from "../socket/socket.js";
import { invalidateFeedCache, invalidateCache } from "../utils/redis.js";

// Cloudinary POSTs here when an async eager transformation finishes
// (see notification_url in videoUploadWorker.js). Anyone who discovers
// this URL could otherwise POST a fake "video ready" payload pointing
// at attacker-controlled media — verifyNotificationSignature checks the
// payload was actually signed by Cloudinary with our API secret before
// any of it is trusted.
//
// Signature verification needs the exact raw request body bytes
// Cloudinary signed — re-serializing the already-parsed req.body with
// JSON.stringify can produce a different string (key order, spacing)
// and would make verification fail even for a genuine request. This
// route is mounted with express.raw() (see routes/webhookRoutes.js) so
// req.body is the raw Buffer here, not pre-parsed JSON.
export const handleCloudinaryWebhook = async (req, res) => {
  try {
    const rawBody = req.body.toString("utf8");
    const parsed = JSON.parse(rawBody);
    const timestamp = parsed.timestamp;
    const signature = req.headers["x-cld-signature"];

    if (!signature || !timestamp) {
      return res.status(400).json({ message: "Missing signature." });
    }

    const isValid = cloudinary.utils.verifyNotificationSignature(
      rawBody,
      timestamp,
      signature,
    );
    if (!isValid) {
      console.warn("Cloudinary webhook: signature verification failed.");
      return res.status(401).json({ message: "Invalid signature." });
    }

    const { notification_type, public_id, eager, context } = parsed;

    // Only eager-transformation completion is relevant here — Cloudinary
    // also sends other notification types (e.g. moderation) this
    // endpoint doesn't need to act on.
    if (notification_type !== "eager") {
      return res.status(200).json({ received: true });
    }

    // postId round-tripped via `context` at upload time (see
    // videoUploadWorker.js) — Cloudinary's payload identifies the asset
    // by public_id, which is Cloudinary's ID, not ours.
    const postId = context?.custom?.postId;
    if (!postId) {
      console.error("Cloudinary webhook: no postId in context, public_id:", public_id);
      return res.status(200).json({ received: true });
    }

    const post = await Post.findById(postId);
    if (!post || post.video?.publicId !== public_id) {
      // Post was deleted, or this callback is for a different/stale
      // asset than what the post currently references — nothing to
      // update.
      return res.status(200).json({ received: true });
    }

    const readyVariant = eager?.[0];
    if (!readyVariant?.secure_url) {
      post.video.status = "failed";
      await post.save();
      return res.status(200).json({ received: true });
    }

    post.video.url = readyVariant.secure_url;
    post.video.status = "ready";
    post.video.durationSeconds = readyVariant.duration || null;
    // Cloudinary can generate a thumbnail from any timestamp in the
    // video via a jpg-format delivery URL — this constructs one at the
    // 1-second mark rather than requiring a second upload/transform job.
    post.video.thumbnailUrl = readyVariant.secure_url
      .replace("/upload/", "/upload/so_1,f_jpg/")
      .replace(/\.mp4$/, ".jpg");
    await post.save();

    invalidateFeedCache(post.user);
    invalidateCache(`profile-posts:${post.user}:*`);

    const payload = {
      postId: post._id,
      video: {
        url: post.video.url,
        thumbnailUrl: post.video.thumbnailUrl,
        durationSeconds: post.video.durationSeconds,
        status: "ready",
      },
    };

    try {
      emitToUser(post.user, "videoReady", payload);
      emitToFollowersOf(post.user, "videoReady", payload);
    } catch (socketError) {
      console.error("Video-ready emission error:", socketError.message);
    }

    res.status(200).json({ received: true });
  } catch (error) {
    console.error("Cloudinary webhook error:", error.message);
    // Still 200 — Cloudinary retries on non-2xx, and retrying a handler
    // that already failed for a code reason (not a transient one) just
    // repeats the same failure.
    res.status(200).json({ received: true });
  }
};
