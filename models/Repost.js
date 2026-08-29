import mongoose from "mongoose";

// Pure amplification edge — one row per (user, post), same pattern as
// Like/Bookmark/Follow. A repost is ALWAYS a thin pointer with no
// content of its own: "user reposted post" and nothing more.
//
// Quotes are NOT modeled here (see the old isQuote/text/hashtags
// fields this used to carry). A quote is a real Post document with
// `quoteOf` set (see models/Post.js) — it has its own text, likes,
// comments, bookmarks, and can itself be reposted via a normal Repost
// edge pointing at the quote's Post id. This edge collection only
// ever needs to know WHO reposted WHICH post (original or quote), so
// toggleRepost works identically for both without branching.
const repostSchema = new mongoose.Schema(
  {
    // Who reposted.
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    // The post being reposted — may be an ordinary post OR a quote
    // post (both are just Post documents now).
    post: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Post",
      required: true,
    },
  },
  { timestamps: true },
);

// One repost per (user, post) — reposting again is a no-op. Enforced
// here, not just in the controller, for race-safety (see
// createRepostEdge).
repostSchema.index({ user: 1, post: 1 }, { unique: true });
// Fast "who reposted this" + reposts-count support.
repostSchema.index({ post: 1, createdAt: -1 });
// Fast "this user's reposts" (feed blending, profile timeline).
repostSchema.index({ user: 1, createdAt: -1 });

const Repost = mongoose.model("Repost", repostSchema);

export default Repost;
