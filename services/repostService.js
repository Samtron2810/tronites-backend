import Repost from "../models/Repost.js";

// Centralizes Repost edge queries — same shape/reasoning as
// likeService.js (a count + "did I do this" boolean, instead of
// controllers each hand-rolling their own queries).

// Did `userId` repost/quote `postId` (either kind)?
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

// List of populated user docs who reposted/quoted `postId` (paginated)
// — same "who liked this" pattern as listLikers.
export const listReposters = async (
  postId,
  select = "name username profilePic",
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

// Create a plain repost edge. Returns false if the user already has
// ANY edge (repost or quote) on this post — race-safety comes from the
// unique index, same idempotent-no-op pattern as createLikeEdge.
export const createRepostEdge = async (userId, postId) => {
  try {
    await Repost.create({ user: userId, post: postId, isQuote: false });
    return true;
  } catch (err) {
    if (err.code === 11000) return false;
    throw err;
  }
};

// Create a quote edge. Same uniqueness rule — a user who already
// reposted/quoted this post must unrepost first (surfaced as a 409 by
// the controller, not silently overwritten here).
export const createQuoteEdge = async (userId, postId, { text, hashtags }) => {
  try {
    const edge = await Repost.create({
      user: userId,
      post: postId,
      isQuote: true,
      text,
      hashtags,
    });
    return edge;
  } catch (err) {
    if (err.code === 11000) return null;
    throw err;
  }
};

// Remove the edge (unrepost / un-quote — same action either way).
// Returns true if an edge was actually deleted.
export const removeRepostEdge = async (userId, postId) => {
  const result = await Repost.deleteOne({ user: userId, post: postId });
  return result.deletedCount > 0;
};

// Delete every repost/quote of a post — used when the ORIGINAL post is
// deleted, so orphaned edges (and orphaned quote text) don't
// accumulate pointing at nothing.
export const removeAllRepostsForPost = (postId) =>
  Repost.deleteMany({ post: postId });

// Every repost/quote a user has made, across all posts — used for
// account deletion so no Repost row is left referencing a purged user.
export const removeAllRepostsForUser = (userId) =>
  Repost.deleteMany({ user: userId });
