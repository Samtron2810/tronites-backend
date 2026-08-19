import mongoose from "mongoose";

// Same pattern as Like.js (post likes) — one edge per (user, comment)
// pair, kept as its own collection rather than a polymorphic Like with
// an optional post/comment field, so the already-shipped post-like
// queries in likeService.js don't need to change shape.
const commentLikeSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    comment: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Comment",
      required: true,
    },
  },
  { timestamps: true },
);

commentLikeSchema.index({ user: 1, comment: 1 }, { unique: true });
commentLikeSchema.index({ comment: 1, createdAt: -1 });
commentLikeSchema.index({ user: 1, createdAt: -1 });

const CommentLike = mongoose.model("CommentLike", commentLikeSchema);

export default CommentLike;
