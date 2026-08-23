import Like from "../models/Like.js";

// Centralizes all like-relationship queries so controllers don't each
// repeat their own Like.find()/countDocuments() calls, and so the
// response shape matches what the old `post.likes` array used to look
// like to the frontend (a count, plus a boolean "did I like this").

// Did `userId` like `postId`?
export const hasLiked = async (userId, postId) => {
  const edge = await Like.exists({ user: userId, post: postId });
  return Boolean(edge);
};

// Raw count — cheap, index-backed, no document scanning regardless of
// how many likes the post has.
export const getLikeCount = (postId) => Like.countDocuments({ post: postId });

// Bulk version of hasLiked, for a page of posts at once (feed/hashtag
// listings) — one query instead of N.
export const getLikedPostIds = async (userId, postIds) => {
  if (!postIds.length) return new Set();
  const edges = await Like.find({
    user: userId,
    post: { $in: postIds },
  })
    .select("post")
    .lean();
  return new Set(edges.map((e) => e.post.toString()));
};

// Bulk like counts for a page of posts at once, via aggregation — avoids
// one countDocuments() per post.
export const getLikeCounts = async (postIds) => {
  if (!postIds.length) return new Map();
  const counts = await Like.aggregate([
    { $match: { post: { $in: postIds } } },
    { $group: { _id: "$post", count: { $sum: 1 } } },
  ]);
  return new Map(counts.map((c) => [c._id.toString(), c.count]));
};

// List of populated user docs who liked `postId` (paginated) — the "who
// liked this" list the old embedded array couldn't support efficiently.
export const listLikers = async (postId, select = "name username profilePic", { skip, limit } = {}) => {
  let query = Like.find({ post: postId })
    .populate("user", select)
    .sort({ createdAt: -1 });
  if (typeof skip === "number") query = query.skip(skip);
  if (typeof limit === "number") query = query.limit(limit);
  const edges = await query;
  return edges.map((e) => e.user).filter(Boolean);
};

// Create the edge. Returns false if it already existed (no-op), true if
// newly created — mirrors createFollowEdge's race-safety: the unique
// index (not a prior read) is what actually prevents a double-like under
// concurrent requests, so a duplicate-key error here is treated as an
// idempotent no-op rather than a real error.
export const createLikeEdge = async (userId, postId) => {
  try {
    await Like.create({ user: userId, post: postId });
    return true;
  } catch (err) {
    if (err.code === 11000) return false;
    throw err;
  }
};

// Remove the edge. Returns true if an edge was actually deleted.
export const removeLikeEdge = async (userId, postId) => {
  const result = await Like.deleteOne({ user: userId, post: postId });
  return result.deletedCount > 0;
};

// Delete every like on a post — used when a post is deleted, so orphaned
// like edges don't accumulate.
export const removeAllLikesForPost = (postId) => Like.deleteMany({ post: postId });

// Every like a user has made, across all posts — used for account
// deletion so no Like row is left referencing a purged user.
export const removeAllLikesForUser = (userId) => Like.deleteMany({ user: userId });
