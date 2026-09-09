import Post from "../models/Post.js";
import { invalidateFeedCache, invalidateCache } from "../utils/redis.js";
import { emitToFollowersOf } from "../socket/socket.js";

// Runs every minute. Finds posts whose scheduledFor <= now and publishes
// them by setting scheduledFor = null, then invalidates caches and
// notifies the author's followers via socket so the post appears in feeds
// immediately without a page refresh.
// The publish moment (a single `now` captured before the query) also
// overwrites createdAt, so the post's displayed time / feed position /
// trending and analytics windows all reflect when it actually went live
// rather than when the creator drafted it. Every display surface already
// renders post.createdAt, so no frontend change is needed.
export const publishScheduledPosts = async () => {
  try {
    const now = new Date();
    const due = await Post.find({
      scheduledFor: { $lte: now },
      removedAt: null,
    })
      .select("_id user")
      .lean();

    if (!due.length) return;

    const ids = due.map((p) => p._id);
    // Mongoose 9's timestamps plugin marks createdAt immutable, and update
    // casting silently DROPS immutable fields from $set unless
    // `overwriteImmutable: true` is passed (see
    // node_modules/mongoose/lib/helpers/query/handleImmutable.js). We
    // WANT to overwrite createdAt here — it represents the publish moment.
    await Post.updateMany(
      { _id: { $in: ids } },
      { $set: { scheduledFor: null, createdAt: now } },
      { overwriteImmutable: true },
    );

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
