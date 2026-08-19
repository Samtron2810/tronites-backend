import mongoose from "mongoose";

// One row per (user, post) save — same pattern as Like/Follow.
const bookmarkSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    post: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Post",
      required: true,
    },
  },
  { timestamps: true },
);

bookmarkSchema.index({ user: 1, post: 1 }, { unique: true });
// Fast "list my saved posts" (paginated, newest-saved-first).
bookmarkSchema.index({ user: 1, createdAt: -1 });

const Bookmark = mongoose.model("Bookmark", bookmarkSchema);

export default Bookmark;
