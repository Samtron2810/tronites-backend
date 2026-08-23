import Bookmark from "../models/Bookmark.js";

export const hasBookmarked = async (userId, postId) => {
  const edge = await Bookmark.exists({ user: userId, post: postId });
  return Boolean(edge);
};

export const getBookmarkedPostIds = async (userId, postIds) => {
  if (!postIds.length) return new Set();
  const edges = await Bookmark.find({
    user: userId,
    post: { $in: postIds },
  })
    .select("post")
    .lean();
  return new Set(edges.map((e) => e.post.toString()));
};

// Create the edge. Returns false if it already existed (no-op), true if
// newly created — same race-safety pattern as createFollowEdge/
// createLikeEdge: the unique index, not this function's read, is what
// actually prevents a double-save under concurrent requests.
export const createBookmarkEdge = async (userId, postId) => {
  try {
    await Bookmark.create({ user: userId, post: postId });
    return true;
  } catch (err) {
    if (err.code === 11000) return false;
    throw err;
  }
};

export const removeBookmarkEdge = async (userId, postId) => {
  const result = await Bookmark.deleteOne({ user: userId, post: postId });
  return result.deletedCount > 0;
};

export const removeAllBookmarksForPost = (postId) => Bookmark.deleteMany({ post: postId });

// Every bookmark a user has made, across all posts — used for account
// deletion so no Bookmark row is left referencing a purged user.
export const removeAllBookmarksForUser = (userId) => Bookmark.deleteMany({ user: userId });

// Paginated list of a user's saved posts, newest-saved-first, with each
// post populated the same way the feed populates posts.
export const listBookmarkedPosts = async (userId, { skip = 0, limit = 12 } = {}) => {
  const [edges, totalBookmarks] = await Promise.all([
    Bookmark.find({ user: userId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate({
        path: "post",
        populate: { path: "user", select: "name username profilePic" },
      }),
    Bookmark.countDocuments({ user: userId }),
  ]);
  // A bookmarked post may have since been deleted — filter those out
  // rather than surfacing a null post to the client.
  const posts = edges.map((e) => e.post).filter(Boolean);
  return { posts, totalBookmarks };
};
