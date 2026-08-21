import Post from "../models/Post.js";
import { invalidateFeedCache, invalidateCache } from "../utils/redis.js";

// Fallback for the Cloudinary Upload Widget video flow: the post shell
// (video.status: "processing") is created server-side *before* the
// widget's picker even opens (see createVideoUploadSignature), so a
// browser crash, closed tab, or lost network before the widget's
// close/error/success callback ever fires leaves an orphaned shell
// behind. CreatePostModal.jsx already deletes the shell on a normal
// cancel/error, but that's a best-effort client-side call — this sweep
// catches whatever slips past it.
//
// Scoped tightly to avoid ever touching a post that's still legitimately
// processing: only shells with no publicId (Cloudinary never even
// confirmed receipt — a real upload records this immediately once
// Cloudinary responds, well before the eager transformation finishes)
// AND older than ABANDONED_THRESHOLD_MS (generous enough that no normal
// upload attempt is still running).
const ABANDONED_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour

export const cleanupAbandonedVideoShells = async () => {
  const cutoff = new Date(Date.now() - ABANDONED_THRESHOLD_MS);

  try {
    const abandoned = await Post.find({
      "video.status": "processing",
      "video.publicId": null,
      createdAt: { $lt: cutoff },
    }).select("_id user");

    if (!abandoned.length) return;

    const affectedUserIds = new Set();
    for (const post of abandoned) {
      affectedUserIds.add(post.user.toString());
    }

    await Post.deleteMany({
      _id: { $in: abandoned.map((post) => post._id) },
    });

    // Best-effort — a stale cache here just means a feed re-fetch is
    // needed to drop the ghost post, not a correctness issue worth
    // failing the sweep over.
    await Promise.all(
      [...affectedUserIds].map(async (userId) => {
        try {
          invalidateFeedCache(userId);
          invalidateCache(`profile-posts:${userId}:*`);
        } catch {
          // ignore — see comment above
        }
      }),
    );

    console.log(
      `Cleaned up ${abandoned.length} abandoned video post shell(s).`,
    );
  } catch (error) {
    console.error("Abandoned video shell cleanup failed:", error.message);
  }
};
