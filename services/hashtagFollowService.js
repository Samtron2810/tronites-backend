import HashtagFollow from "../models/HashtagFollow.js";

// Centralizes hashtag-follow queries, same reasoning as followService.js.

export const isFollowingHashtag = async (userId, tag) => {
  const edge = await HashtagFollow.exists({ user: userId, tag });
  return Boolean(edge);
};

// True only for a real, user-initiated follow — used by the frontend's
// "Following" button state, which must never show as active for a tag
// the user never actually chose (implicit edges are invisible to them
// by design; see models/HashtagFollow.js's `implicit` field comment).
export const isExplicitlyFollowingHashtag = async (userId, tag) => {
  const edge = await HashtagFollow.exists({ user: userId, tag, implicit: false });
  return Boolean(edge);
};

export const followHashtag = async (userId, tag) => {
  try {
    await HashtagFollow.create({ user: userId, tag, implicit: false });
    return true;
  } catch (err) {
    if (err.code !== 11000) throw err;
    // Duplicate key — an edge already exists. If it's an implicit one
    // from the nightly job, a real user tap now upgrades it to
    // explicit rather than silently no-op'ing (which would leave the
    // "Follow" button stuck showing the wrong state forever). If it's
    // already explicit, this really is a no-op.
    const result = await HashtagFollow.updateOne(
      { user: userId, tag, implicit: true },
      { $set: { implicit: false } },
    );
    return result.modifiedCount > 0;
  }
};

export const unfollowHashtag = async (userId, tag) => {
  const result = await HashtagFollow.deleteOne({ user: userId, tag });
  return result.deletedCount > 0;
};

// Raw lowercase tag list a user follows (explicit + implicit) — used by
// For You's interest source (services/forYouService.js), which
// shouldn't care how the follow was derived.
export const listFollowedHashtags = async (userId) => {
  const edges = await HashtagFollow.find({ user: userId })
    .select("tag createdAt")
    .sort({ createdAt: -1 })
    .lean();
  return edges.map((e) => e.tag);
};

// Tags the user follows *explicitly* — used for the settings/hashtags
// list page, so implicit follows don't clutter a page whose whole point
// is showing the user their own deliberate choices.
export const listExplicitlyFollowedHashtags = async (userId) => {
  const edges = await HashtagFollow.find({ user: userId, implicit: false })
    .select("tag createdAt")
    .sort({ createdAt: -1 })
    .lean();
  return edges.map((e) => e.tag);
};

export const getHashtagFollowerCount = (tag) =>
  HashtagFollow.countDocuments({ tag });

export const removeAllHashtagFollowsForUser = (userId) =>
  HashtagFollow.deleteMany({ user: userId });

// Bulk-create implicit follows, skipping any (user, tag) pair that
// already has ANY edge (explicit or implicit) — used by
// jobs/computeForYouSignals.js's recomputeImplicitHashtagFollows.
// insertMany with ordered:false so one duplicate-key collision doesn't
// abort the rest of the batch; duplicates are expected and cheap here,
// not an error case.
export const bulkCreateImplicitFollows = async (pairs) => {
  if (!pairs.length) return { inserted: 0 };
  try {
    const result = await HashtagFollow.insertMany(
      pairs.map(({ userId, tag }) => ({ user: userId, tag, implicit: true })),
      { ordered: false },
    );
    return { inserted: result.length };
  } catch (err) {
    // insertMany with ordered:false throws a BulkWriteError that still
    // reports how many succeeded before/around the duplicate-key
    // failures — those are expected (edge already exists) and not a
    // real failure.
    if (err.name === "MongoBulkWriteError" || err.code === 11000) {
      return { inserted: err.result?.nInserted ?? 0 };
    }
    throw err;
  }
};

// Removes implicit follows whose signal has gone stale (see the job's
// own threshold logic) — mirrors the lastPostAt stale-clear pattern in
// computeForYouSignals.js. Never touches explicit edges.
//
// Chunked — an $or with thousands of clauses in one query is a real
// risk at platform scale (BSON document size limits on the query
// itself, plus poor planner behavior), so pairs are batched.
const REMOVE_CHUNK_SIZE = 500;
export const removeImplicitFollows = async (pairs) => {
  if (!pairs.length) return { removed: 0 };
  let removed = 0;
  for (let i = 0; i < pairs.length; i += REMOVE_CHUNK_SIZE) {
    const chunk = pairs.slice(i, i + REMOVE_CHUNK_SIZE);
    const result = await HashtagFollow.deleteMany({
      implicit: true,
      $or: chunk.map(({ userId, tag }) => ({ user: userId, tag })),
    });
    removed += result.deletedCount || 0;
  }
  return { removed };
};
