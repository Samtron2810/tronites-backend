import mongoose from "mongoose";

const postSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    text: {
      type: String,
      default: "",
      maxlength: 280,
    },

    // Quote post support — set only when this Post IS a quote. A quote
    // is a real, independently-authored Post (own text/hashtags/likes/
    // comments/bookmarks/reposts) that additionally embeds another
    // post. Unlike the original 1.1 design (quotes as synthetic
    // `Repost{isQuote:true}` edges with no Post doc), quoteOf makes a
    // quote a first-class Post so every existing post-scoped action
    // (like/comment/bookmark/repost, direct-ID routes, feed/profile/
    // hashtag/search listings) works on it automatically with zero
    // special-casing. Never set on the post being quoted — one level
    // of embedding only, enforced in the controller (quoting a quote
    // is rejected there, not modeled here).
    quoteOf: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Post",
      default: null,
    },

    // Parsed from `text` at creation time (lowercased, no # prefix).
    // Indexed for hashtag search/browse.
    hashtags: {
      type: [String],
      default: [],
    },

    // Post audience — who can see this post, chosen at creation time.
    // Deliberately not editable after posting (matches the "images are
    // fixed after posting" policy).
    //   public    -> everyone
    //   followers -> the author + the author's followers
    //   only-me   -> the author only
    // Legacy posts created before this field existed have it missing;
    // every read path treats missing exactly like "public" (see
    // services/postVisibilityService.js).
    privacy: {
      type: String,
      enum: ["public", "followers", "only-me"],
      default: "public",
    },

    // Carousel images (max 4).
    images: {
      type: [String],
      default: [],
      validate: {
        validator: (arr) => arr.length <= 4,
        message: "A post can have at most 4 images",
      },
    },

    // A post carries images OR a single video, never both — keeps the
    // feed card's media layout (carousel vs. player) unambiguous and
    // matches how Twitter/Instagram scope a single post's attached media.
    video: {
      publicId: { type: String, default: null },
      // Populated once Cloudinary's processing webhook confirms the
      // eager-transformation (trim/transcode) has finished. Empty/null
      // while status is "processing".
      url: { type: String, default: null },
      thumbnailUrl: { type: String, default: null },
      // Capped at 30s by the upload-time eager transformation (see
      // videoUploadQueue.js) — this stores the actual resulting
      // duration for display, not a limit enforced here.
      durationSeconds: { type: Number, default: null },
      status: {
        type: String,
        enum: ["processing", "ready", "failed"],
        default: null,
      },
    },

    likesCount: {
      type: Number,
      default: 0,
    },

    commentsCount: {
      type: Number,
      default: 0,
    },

    // Denormalized count of Repost edges (plain reposts + quotes
    // combined) pointing at this post — same reasoning/pattern as
    // likesCount/commentsCount: cheap to read on every feed render,
    // kept in sync via $inc at the point of repost/unrepost rather
    // than a live Repost.countDocuments() per post.
    repostsCount: {
      type: Number,
      default: 0,
    },

    // Text-only edit support. Images are fixed after posting — editing
    // is intentionally scoped to text (+ hashtag/mention re-parse) for
    // now, not image replacement.
    edited: {
      type: Boolean,
      default: false,
    },
    editedAt: {
      type: Date,
      default: null,
    },

    // Moderator soft-takedown (Phase 1 — see services/reportService.js).
    // The post stays in the database for audit/reversal, but every
    // user-facing read filters on removedAt: null, so it disappears from
    // feeds/profiles/hashtag/search exactly like a hard delete would —
    // without destroying the author's media or the report trail.
    // removedBy/removalReason are moderator-only facts and only ever
    // surface through the requireModerator-gated /reports endpoints.
    removedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    removedAt: {
      type: Date,
      default: null,
    },
    removalReason: {
      type: String,
      default: "",
      trim: true,
      maxlength: 500,
    },

    // Fairness fix #2 — real-time engagement-velocity circuit breaker.
    // Set by likePost/reactToPost/addComment (see postController.js/
    // commentController.js) when a post's engagement-to-follower ratio
    // in its first hour is statistically implausible for its author's
    // real audience size — the classic "bought engagement" pattern.
    // This is a CHEAP heuristic flag, not a verdict: it exists so the
    // nightly credibleRatio sweep (jobs/computeForYouSignals.js) can
    // prioritize the post's author on its very next run instead of
    // waiting up to 24h, and so trending/interest sourcing can
    // deprioritize the post in the meantime. A human/the nightly job
    // makes the real call; this field only shortens how long a gamed
    // post can ride front-page visibility before that happens.
    velocityFlagged: {
      type: Boolean,
      default: false,
    },
    velocityFlaggedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true },
);

// Indexes
postSchema.index({ user: 1, createdAt: -1 });
postSchema.index({ hashtags: 1, createdAt: -1 });
// jobs/computeForYouSignals.js's recomputeSuggestionSignals aggregation
// matches on (removedAt, createdAt) with no user filter, then sorts by
// createdAt before grouping — neither compound index above leads with
// a field that query filters on, so it would otherwise collection-scan
// every run.
postSchema.index({ removedAt: 1, createdAt: -1 });
// Full-text search over post captions (Explore's content search). A
// regex scan would work for small collections but doesn't use an index
// and gets slower linearly with post count; MongoDB's $text operator
// uses this index and also gives relevance scoring for free.
postSchema.index({ text: "text" });
// Fairness fix #2 — lets the nightly sweep cheaply find posts flagged
// since its last run, and lets forYouService/getTrendingPosts exclude
// flagged posts from ranking without a collection scan.
postSchema.index({ velocityFlagged: 1, velocityFlaggedAt: -1 });

const Post = mongoose.model("Post", postSchema);

export default Post;
