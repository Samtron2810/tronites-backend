import Post from "../models/Post.js";
import { invalidateCache, invalidateFeedCache } from "../utils/redis.js";

// ---------------------------------------------------------------------------
// GET /posts/scheduled
// Lists the creator's upcoming scheduled posts, newest scheduled-for first.
// ---------------------------------------------------------------------------
export const getScheduledPosts = async (req, res) => {
  try {
    const posts = await Post.find({
      user: req.user._id,
      scheduledFor: { $gt: new Date() },
      removedAt: null,
    })
      .sort({ scheduledFor: 1 })
      .select("_id text images video privacy scheduledFor createdAt")
      .lean();

    res.status(200).json({ posts });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ---------------------------------------------------------------------------
// PUT /posts/:id/schedule  { scheduledFor: ISO string }
// Schedules an existing draft/live post for (re-)publishing at a future time.
// Only the post owner can schedule their own posts.
// ---------------------------------------------------------------------------
export const schedulePost = async (req, res) => {
  try {
    const post = await Post.findById(req.params.id);
    if (!post || post.removedAt) {
      return res.status(404).json({ message: "Post not found." });
    }
    if (post.user.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: "Not your post." });
    }

    const scheduledFor = new Date(req.body.scheduledFor);
    post.scheduledFor = scheduledFor;
    await post.save();

    res.status(200).json({ post: { _id: post._id, scheduledFor: post.scheduledFor } });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ---------------------------------------------------------------------------
// DELETE /posts/:id/schedule
// Cancels a scheduled post (sets scheduledFor = null, publishes immediately).
// ---------------------------------------------------------------------------
export const unschedulePost = async (req, res) => {
  try {
    const post = await Post.findById(req.params.id);
    if (!post || post.removedAt) {
      return res.status(404).json({ message: "Post not found." });
    }
    if (post.user.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: "Not your post." });
    }

    // The post becomes visible the moment this runs — stamp createdAt so
    // its displayed time / feed position reflect the actual publish
    // instant ("Publish now"), matching what the cron job does for
    // auto-published scheduled posts. Mongoose 9's timestamps plugin
    // marks createdAt immutable, so the overwriteImmutable option is
    // required — otherwise the set() is ignored on save().
    post.set("createdAt", new Date(), { overwriteImmutable: true });
    post.scheduledFor = null;
    await post.save();

    invalidateFeedCache(req.user._id);
    invalidateCache(`profile-posts:${req.user._id}:*`);

    res.status(200).json({ message: "Post published immediately.", post: { _id: post._id } });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
