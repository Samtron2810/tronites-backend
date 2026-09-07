import Post from "../models/Post.js";
import { invalidateFeedCache, invalidateCache } from "../utils/redis.js";
import { emitToFollowersOf } from "../socket/socket.js";

// Runs every minute. Finds posts whose scheduledFor <= now and publishes
// them by setting scheduledFor = null, then invalidates caches and
// notifies the author's followers via socket so the post appears in feeds
// immediately without a page refresh.
export const publishScheduledPosts = async () => {
  try {
    const due = await Post.find({
      scheduledFor: { $lte: new Date() },
      removedAt: null,
    })
      .select("_id user")
      .lean();

    if (!due.length) return;

    const ids = due.map((p) => p._id);
    await Post.updateMany({ _id: { $in: ids } }, { $set: { scheduledFor: null } });

    // Invalidate per-author caches and notify followers
    const authorIds = [...new Set(due.map((p) => p.user.toString()))];
    for (const authorId of authorIds) {
      invalidateFeedCache(authorId);
      invalidateCache(`profile-posts:${authorId}:*`);
      try {
        emitToFollowersOf(authorId, "scheduledPostPublished", { authorId });
      } catch {
        // socket emit is best-effort
      }
    }

    console.log(`[publishScheduledPosts] Published ${due.length} scheduled post(s).`);
  } catch (err) {
    console.error("[publishScheduledPosts] Error:", err.message);
  }
};
