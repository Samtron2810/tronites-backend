import CommentLike from "../models/CommentLike.js";

export const hasLikedComment = async (userId, commentId) => {
  const edge = await CommentLike.exists({ user: userId, comment: commentId });
  return Boolean(edge);
};

export const getLikedCommentIds = async (userId, commentIds) => {
  if (!commentIds.length) return new Set();
  const edges = await CommentLike.find({
    user: userId,
    comment: { $in: commentIds },
  })
    .select("comment")
    .lean();
  return new Set(edges.map((e) => e.comment.toString()));
};

export const createCommentLikeEdge = async (userId, commentId) => {
  try {
    await CommentLike.create({ user: userId, comment: commentId });
    return true;
  } catch (err) {
    if (err.code === 11000) return false;
    throw err;
  }
};

export const removeCommentLikeEdge = async (userId, commentId) => {
  const result = await CommentLike.deleteOne({ user: userId, comment: commentId });
  return result.deletedCount > 0;
};

export const removeAllLikesForComment = (commentId) =>
  CommentLike.deleteMany({ comment: commentId });

// Bulk: delete every like row for a batch of comments — used when a
// parent comment is deleted along with its replies.
export const removeAllLikesForComments = (commentIds) =>
  CommentLike.deleteMany({ comment: { $in: commentIds } });

// Every comment-like a user has made — used for account deletion so no
// CommentLike row is left referencing a purged user.
export const removeAllCommentLikesForUser = (userId) =>
  CommentLike.deleteMany({ user: userId });
