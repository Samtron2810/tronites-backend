import mongoose from "mongoose";

// 2.3 — Follow hashtags. Same edge-collection pattern as Follow/Block/
// Mute (see models/Follow.js's comment on why: no embedded arrays, no
// 16MB document ceiling, index-backed lookups regardless of how many
// tags a user follows or how many followers a tag has).
//
// Tags are stored lowercase, no leading '#' — matches Post.hashtags and
// utils/textParser.js's extractHashtags output exactly, so a followed
// tag can be matched against Post.hashtags with zero normalization at
// query time.
const hashtagFollowSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    tag: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      maxlength: 50,
    },
  },
  { timestamps: true },
);

// One edge per (user, tag) — fast existence checks and prevents
// duplicate follows.
hashtagFollowSchema.index({ user: 1, tag: 1 }, { unique: true });
// Fast "who follows #tag" (follower-count display, future notify-on-
// trend features) and "which tags does user X follow" (feed sourcing,
// settings page listing).
hashtagFollowSchema.index({ tag: 1, createdAt: -1 });
hashtagFollowSchema.index({ user: 1, createdAt: -1 });

const HashtagFollow = mongoose.model("HashtagFollow", hashtagFollowSchema);

export default HashtagFollow;
