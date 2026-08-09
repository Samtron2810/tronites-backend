import mongoose from "mongoose";

// Replaces the old `followers`/`following` arrays embedded on User.
//
// Why: MongoDB documents cap out at 16MB. A user with a very large
// follower count risks hitting that ceiling — and even well before the
// hard limit, `currentUser.following.includes(id)` and
// `.filter(id => ...)` scan the entire array in memory on every
// follow/unfollow, which gets slower as the count grows. A separate
// collection with one row per (follower, following) edge scales the same
// way regardless of how many followers any single user has — lookups use
// indexes instead of full-array scans.
const followSchema = new mongoose.Schema(
  {
    // The user doing the following
    follower: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    // The user being followed
    following: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  { timestamps: true },
);

// One edge per pair, and fast existence checks ("does A follow B?") in
// either direction via the compound index below.
followSchema.index({ follower: 1, following: 1 }, { unique: true });

// Fast "who follows user X" (getFollowers) and "who does X follow"
// (getFollowing) lookups.
followSchema.index({ following: 1, createdAt: -1 });
followSchema.index({ follower: 1, createdAt: -1 });

const Follow = mongoose.model("Follow", followSchema);

export default Follow;
