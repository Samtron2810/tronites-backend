import Reaction, { REACTION_EMOJIS } from "../models/Reaction.js";

// Centralizes reaction queries the same way likeService does for likes —
// controllers get a count-per-emoji summary + "did I react, and with
// what" instead of each repeating raw Reaction queries.

// This user's current reaction on a target, or null.
export const getUserReaction = async (userId, targetType, targetId) => {
  const edge = await Reaction.findOne({ user: userId, targetType, targetId })
    .select("emoji")
    .lean();
  return edge?.emoji || null;
};

// Grouped counts for a single target: { "❤️": 3, "😂": 1, ... } — only
// emojis with at least one reaction are included.
export const getReactionSummary = async (targetType, targetId) => {
  const counts = await Reaction.aggregate([
    { $match: { targetType, targetId } },
    { $group: { _id: "$emoji", count: { $sum: 1 } } },
  ]);
  const summary = {};
  for (const { _id, count } of counts) summary[_id] = count;
  return summary;
};

// Bulk version for a page of targets at once (feed/thread listings) —
// one aggregation instead of N. Returns Map<targetId, { emoji: count }>.
export const getReactionSummaries = async (targetType, targetIds) => {
  if (!targetIds.length) return new Map();
  const counts = await Reaction.aggregate([
    { $match: { targetType, targetId: { $in: targetIds } } },
    {
      $group: {
        _id: { targetId: "$targetId", emoji: "$emoji" },
        count: { $sum: 1 },
      },
    },
  ]);
  const map = new Map();
  for (const { _id, count } of counts) {
    const key = _id.targetId.toString();
    if (!map.has(key)) map.set(key, {});
    map.get(key)[_id.emoji] = count;
  }
  return map;
};

// Bulk version of getUserReaction for a page of targets — one query
// instead of N. Returns Map<targetId, emoji>.
export const getUserReactions = async (userId, targetType, targetIds) => {
  if (!targetIds.length) return new Map();
  const edges = await Reaction.find({
    user: userId,
    targetType,
    targetId: { $in: targetIds },
  })
    .select("targetId emoji")
    .lean();
  return new Map(edges.map((e) => [e.targetId.toString(), e.emoji]));
};

// Paginated list of users who reacted, optionally filtered to one emoji
// — the "who reacted" breakdown sheet.
export const listReactors = async (
  targetType,
  targetId,
  { emoji, select = "name username profilePic verifications isVerified", skip, limit } = {},
) => {
  const filter = { targetType, targetId };
  if (emoji) filter.emoji = emoji;
  let query = Reaction.find(filter)
    .populate("user", select)
    .sort({ createdAt: -1 });
  if (typeof skip === "number") query = query.skip(skip);
  if (typeof limit === "number") query = query.limit(limit);
  const edges = await query;
  return edges.map((e) => ({ user: e.user, emoji: e.emoji })).filter((r) => r.user);
};

// Set (create or change) a user's reaction on a target. Upsert, not
// create+catch-11000 — a reaction is "at most one per user per target",
// so changing the emoji is just overwriting the row, unlike Like where
// the edge is binary (exists / doesn't). Returns the previous emoji (or
// null if this is a new reaction) so the caller can adjust per-emoji
// counters correctly.
export const setReaction = async (userId, targetType, targetId, emoji) => {
  const previous = await Reaction.findOneAndUpdate(
    { user: userId, targetType, targetId },
    { $set: { emoji } },
    { upsert: true, new: false },
  ).lean();
  return previous?.emoji || null;
};

// Remove a user's reaction entirely. Returns the removed emoji, or null
// if there was nothing to remove.
export const removeReaction = async (userId, targetType, targetId) => {
  const removed = await Reaction.findOneAndDelete({
    user: userId,
    targetType,
    targetId,
  }).lean();
  return removed?.emoji || null;
};

// Cascade cleanup — every reaction pointing at one target (post/message
// deletion).
export const removeAllReactionsForTarget = (targetType, targetId) =>
  Reaction.deleteMany({ targetType, targetId });

// Cascade cleanup — every reaction across many targets at once (bulk
// post deletion during account purge).
export const removeAllReactionsForTargets = (targetType, targetIds) => {
  if (!targetIds.length) return Promise.resolve();
  return Reaction.deleteMany({ targetType, targetId: { $in: targetIds } });
};

// Every reaction a user has made, across all targets — account deletion.
export const removeAllReactionsForUser = (userId) =>
  Reaction.deleteMany({ user: userId });

export { REACTION_EMOJIS };
