import mongoose from "mongoose";

const commentSchema = new mongoose.Schema(
  {
    post: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Post",
      required: true,
    },

    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    text: {
      type: String,
      required: true,
      maxlength: 280,
    },

    // Null = top-level comment. Set = this is a reply to that comment.
    // Enforced 1-level deep at the controller (replies can't have a
    // parentComment that is itself a reply).
    parentComment: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Comment",
      default: null,
    },

    repliesCount: {
      type: Number,
      default: 0,
    },

    likesCount: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true },
);

// Indexes
commentSchema.index({ post: 1, createdAt: -1 });
commentSchema.index({ user: 1 });
commentSchema.index({ parentComment: 1, createdAt: 1 });

const Comment = mongoose.model("Comment", commentSchema);

export default Comment;
