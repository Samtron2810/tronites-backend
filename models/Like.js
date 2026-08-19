import mongoose from "mongoose";

// Replaces the old `likes` array embedded on Post.
//
// Why: same problem the old `followers`/`following` arrays on User had.
// A viral post's `likes: [ObjectId]` array grows without bound (risking
// the 16MB document cap on an extreme outlier, and realistically just
// getting slower to load/save well before that), and every like/unlike
// did `post.likes.some(...)`/`.filter(...)` — a full array scan in
// memory that gets slower as the post gets more popular. A separate
// collection with one row per (user, post) edge scales the same way
// regardless of how many likes any single post has — lookups use
// indexes instead of full-array scans.
const likeSchema = new mongoose.Schema(
  {
    // The user who liked the post
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    // The post being liked
    post: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Post",
      required: true,
    },
  },
  { timestamps: true },
);

// One edge per (user, post) pair — also what makes createLikeEdge's
// duplicate-like handling a race-safe no-op via the E11000 error path,
// the same pattern used for Follow.
likeSchema.index({ user: 1, post: 1 }, { unique: true });

// Fast "who liked post X" (paginated) and "does user X like post Y"
// lookups.
likeSchema.index({ post: 1, createdAt: -1 });
// Fast "posts liked by user X" lookups.
likeSchema.index({ user: 1, createdAt: -1 });

const Like = mongoose.model("Like", likeSchema);

export default Like;
