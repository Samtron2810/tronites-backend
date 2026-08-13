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

    likes: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
      },
    ],

    commentsCount: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true },
);

// Indexes
postSchema.index({ user: 1, createdAt: -1 });
postSchema.index({ likes: 1 });
postSchema.index({ hashtags: 1, createdAt: -1 });

const Post = mongoose.model("Post", postSchema);

export default Post;
