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

    // Parsed from `text` at creation time (lowercased, no # prefix).
    // Indexed for hashtag search/browse.
    hashtags: {
      type: [String],
      default: [],
    },

    // Legacy single-image field — kept so old posts keep rendering.
    // New posts use `images` below instead.
    image: {
      type: String,
      default: "",
    },

    // Carousel images (max 4). New posts write here; `image` stays empty.
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
  },
  { timestamps: true },
);

// Indexes
postSchema.index({ user: 1, createdAt: -1 });
postSchema.index({ hashtags: 1, createdAt: -1 });
// Full-text search over post captions (Explore's content search). A
// regex scan would work for small collections but doesn't use an index
// and gets slower linearly with post count; MongoDB's $text operator
// uses this index and also gives relevance scoring for free.
postSchema.index({ text: "text" });

const Post = mongoose.model("Post", postSchema);

export default Post;
