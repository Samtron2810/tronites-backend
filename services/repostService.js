import Repost from "../models/Repost.js";

// Centralizes Repost edge queries — same shape/reasoning as
// likeService.js (a count + "did I do this" boolean, instead of
// controllers each hand-rolling their own queries). Works identically
// for an ordinary post or a quote post — both are just a `postId` to
// this collection now (see models/Repost.js).

// Did `userId` repost `postId`?
export const hasReposted = async (userId, postId) => {
  const edge = await Repost.exists({ user: userId, post: postId });
  return Boolean(edge);
};

// Bulk version for a page of posts at once (feed/hashtag/profile
// listings) — one query instead of N.
export const getRepostedPostIds = async (userId, postIds) => {
  if (!postIds.length) return new Set();
  const edges = await Repost.find({
    user: userId,
    post: { $in: postIds },
  })
    .select("post")
    .lean();
  return new Set(edges.map((e) => e.post.toString()));
};

// Bulk repost counts, via aggregation — avoids one countDocuments()
// per post.
export const getRepostCounts = async (postIds) => {
  if (!postIds.length) return new Map();
  const counts = await Repost.aggregate([
    { $match: { post: { $in: postIds } } },
    { $group: { _id: "$post", count: { $sum: 1 } } },
  ]);
  return new Map(counts.map((c) => [c._id.toString(), c.count]));
};

// List of populated user docs who reposted `postId` (paginated) —
// same "who liked this" pattern as listLikers.
export const listReposters = async (
  postId,
  select = "name username profilePic verifications isVerified",
  { skip, limit } = {},
) => {
  let query = Repost.find({ post: postId })
    .populate("user", select)
    .sort({ createdAt: -1 });
  if (typeof skip === "number") query = query.skip(skip);
  if (typeof limit === "number") query = query.limit(limit);
  const edges = await query;
  return edges.map((e) => e.user).filter(Boolean);
};

// Create a repost edge. Returns false if the user already reposted
// this post — race-safety comes from the unique index, same
// idempotent-no-op pattern as createLikeEdge.
export const createRepostEdge = async (userId, postId) => {
  try {
    await Repost.create({ user: userId, post: postId });
    return true;
  } catch (err) {
    if (err.code === 11000) return false;
    throw err;
  }
};

// Remove the edge (unrepost).
// Returns true if an edge was actually deleted.
export const removeRepostEdge = async (userId, postId) => {
  const result = await Repost.deleteOne({ user: userId, post: postId });
  return result.deletedCount > 0;
};

// Delete every repost of a post — used when the post (original or
// quote) is deleted, so orphaned edges don't accumulate pointing at
// nothing.
export const removeAllRepostsForPost = (postId) =>
  Repost.deleteMany({ post: postId });

// Every repost a user has made, across all posts — used for account
// deletion so no Repost row is left referencing a purged user.
export const removeAllRepostsForUser = (userId) =>
  Repost.deleteMany({ user: userId });
