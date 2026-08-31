import Follow from "../models/Follow.js";
import User from "../models/User.js";

// Centralizes all follow-relationship queries so controllers don't each
// repeat their own Follow.find()/countDocuments() calls, and so the
// response shape (arrays of populated user objects, or counts) matches
// what the old array-based fields used to look like to the frontend.

// Is `followerId` currently following `followingId`?
export const isFollowing = async (followerId, followingId) => {
  const edge = await Follow.exists({ follower: followerId, following: followingId });
  return Boolean(edge);
};

// Raw counts — cheap, index-backed, no document scanning regardless of
// how large the follower list is.
export const getFollowerCount = (userId) => Follow.countDocuments({ following: userId });
export const getFollowingCount = (userId) => Follow.countDocuments({ follower: userId });

// List of populated user docs who follow `userId` (used by getFollowers).
// `skip`/`limit` are optional — omit both for the full unpaginated list
// (used by Profile's follower/following preview arrays).
export const listFollowers = async (userId, select = "name profilePic bio", { skip, limit } = {}) => {
  let query = Follow.find({ following: userId })
    .populate("follower", select)
    .sort({ createdAt: -1 });
  if (typeof skip === "number") query = query.skip(skip);
  if (typeof limit === "number") query = query.limit(limit);
  const edges = await query;
  return edges.map((e) => e.follower).filter(Boolean);
};

// List of populated user docs `userId` follows (used by getFollowing).
export const listFollowing = async (userId, select = "name profilePic bio", { skip, limit } = {}) => {
  let query = Follow.find({ follower: userId })
    .populate("following", select)
    .sort({ createdAt: -1 });
  if (typeof skip === "number") query = query.skip(skip);
  if (typeof limit === "number") query = query.limit(limit);
  const edges = await query;
  return edges.map((e) => e.following).filter(Boolean);
};

// Just the raw ObjectId list of who `userId` follows — used where the
// old code did `currentUser.following.map(id => id.toString())` to
// build an exclusion list (e.g. search: "users I don't already follow").
export const listFollowingIds = async (userId) => {
  const edges = await Follow.find({ follower: userId }).select("following").lean();
  return edges.map((e) => e.following.toString());
};

// Create the edge. Returns false if it already existed (no-op), true if
// newly created — callers use this to decide whether to fire a
// notification.
export const createFollowEdge = async (followerId, followingId) => {
  try {
    await Follow.create({ follower: followerId, following: followingId });
    // Denormalized for For You ranking (see models/User.js followersCount).
    // Best-effort: a crash between the two writes is caught by the
    // nightly reconciliation job, not retried here.
    await User.updateOne({ _id: followingId }, { $inc: { followersCount: 1 } });
    return true;
  } catch (err) {
    // Duplicate key = edge already exists (schema's unique index) — treat
    // as a no-op rather than an error.
    if (err.code === 11000) return false;
    throw err;
  }
};

// Remove the edge. Returns true if an edge was actually deleted.
export const removeFollowEdge = async (followerId, followingId) => {
  const result = await Follow.deleteOne({ follower: followerId, following: followingId });
  if (result.deletedCount > 0) {
    await User.updateOne(
      { _id: followingId, followersCount: { $gt: 0 } },
      { $inc: { followersCount: -1 } },
    );
  }
  return result.deletedCount > 0;
};

// For You candidate sourcing (2nd-degree / "friends of follows"): given
// the ids the viewer already follows, returns the ids THOSE people
// follow, excluding anyone in `excludeIds` (viewer + already-followed +
// self). Capped via `sampleSize` since a viewer following many active
// accounts can fan out to a huge set — this only needs to be big enough
// to sample candidates from, not exhaustive.
export const listFriendsOfFollowsIds = async (followingIds, excludeIds, sampleSize = 300) => {
  if (!followingIds.length) return [];
  const edges = await Follow.find({ follower: { $in: followingIds } })
    .select("following")
    .limit(sampleSize)
    .lean();
  const exclude = new Set(excludeIds.map((id) => id.toString()));
  const seen = new Set();
  const result = [];
  for (const e of edges) {
    const id = e.following.toString();
    if (exclude.has(id) || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
};

// Every follow edge involving a user, in either direction — used for
// account deletion so no Follow row is left referencing a purged user
// (as either the follower or the one being followed).
export const removeAllFollowEdgesForUser = (userId) =>
  Follow.deleteMany({ $or: [{ follower: userId }, { following: userId }] });
