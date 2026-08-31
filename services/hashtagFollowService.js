import HashtagFollow from "../models/HashtagFollow.js";

// Centralizes hashtag-follow queries, same reasoning as followService.js.

export const isFollowingHashtag = async (userId, tag) => {
  const edge = await HashtagFollow.exists({ user: userId, tag });
  return Boolean(edge);
};

export const followHashtag = async (userId, tag) => {
  try {
    await HashtagFollow.create({ user: userId, tag });
    return true;
  } catch (err) {
    // Duplicate key = already following — no-op, not an error.
    if (err.code === 11000) return false;
    throw err;
  }
};

export const unfollowHashtag = async (userId, tag) => {
  const result = await HashtagFollow.deleteOne({ user: userId, tag });
  return result.deletedCount > 0;
};

// Raw lowercase tag list a user follows — used by For You's interest
// source (services/forYouService.js) and the settings/hashtags list.
export const listFollowedHashtags = async (userId) => {
  const edges = await HashtagFollow.find({ user: userId })
    .select("tag createdAt")
    .sort({ createdAt: -1 })
    .lean();
  return edges.map((e) => e.tag);
};

export const getHashtagFollowerCount = (tag) =>
  HashtagFollow.countDocuments({ tag });

export const removeAllHashtagFollowsForUser = (userId) =>
  HashtagFollow.deleteMany({ user: userId });
