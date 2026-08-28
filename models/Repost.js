import mongoose from "mongoose";

// Amplification edge — one row per (user, post), same pattern as
// Like/Bookmark/Follow. Covers BOTH mechanics from the roadmap (1.1):
//   - Plain repost: isQuote: false, no text of its own — a thin
//     pointer that says "user reposted post" and nothing more.
//   - Quote post: isQuote: true, carries its own text/hashtags — a
//     real, independently-authored post that embeds the original.
// Kept as ONE collection (not two) because both share the same
// uniqueness rule (a user can only repost-or-quote a given post once —
// unrepost/un-quote deletes the edge, same as unlike), the same feed
// dedup logic, and the same cascade-delete story on original-post
// removal. Splitting them would just duplicate all of that.
const repostSchema = new mongoose.Schema(
  {
    // Who reposted/quoted.
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    // The original post being amplified. Deliberately NOT `repostOf`
    // on the Post model itself (the roadmap's suggested shape) —
    // keeping this as its own edge collection means a repost never
    // needs its own Post document, which keeps the feed dedup and
    // "unrepost" cascade as simple index-backed deletes instead of a
    // second post lifecycle to maintain.
    post: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Post",
      required: true,
    },
    isQuote: {
      type: Boolean,
      default: false,
    },
    // Only populated when isQuote is true. A quote's own caption —
    // same 280-char/hashtag-parse rules as a normal post, enforced in
    // the controller/validator, not here.
    text: {
      type: String,
      default: "",
      maxlength: 280,
    },
    hashtags: {
      type: [String],
      default: [],
    },
  },
  { timestamps: true },
);

// One repost/quote per (user, post) — reposting again is a no-op,
// quoting again would need to unrepost the plain one first (mirrors
// how you can't like a post twice). Enforced here, not just in the
// controller, for the same race-safety reason as Like's index.
repostSchema.index({ user: 1, post: 1 }, { unique: true });
// Fast "who reposted this" + reposts-count support.
repostSchema.index({ post: 1, createdAt: -1 });
// Fast "this user's reposts" (feed blending, profile "reposts" tab if
// added later).
repostSchema.index({ user: 1, createdAt: -1 });

const Repost = mongoose.model("Repost", repostSchema);

export default Repost;
