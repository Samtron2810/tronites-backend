import mongoose from "mongoose";

export const PERMISSIONS = [
  "manage_reports",
  "manage_users",
  "manage_content",
  "view_audit_log",
  "manage_roles",
  "manage_verification",
];

export const VERIFICATION_TYPES = [
  "individual",
  "business",
  "government",
  "creator",
  "staff",
];

export const DEFAULT_MODERATOR_PERMISSIONS = [
  "manage_reports",
  "manage_users",
  "manage_content",
];

// All available interest topics
export const AVAILABLE_TOPICS = [
  "technology", "music", "art", "sports", "gaming", "science",
  "politics", "food", "travel", "fashion", "finance", "health",
  "education", "entertainment", "news", "business", "nature",
  "photography", "fitness", "books",
];

const userSchema = new mongoose.Schema(
  {
    firstName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 30,
      match: /^[\p{L}\p{M}][\p{L}\p{M}' -]*$/u,
    },

    lastName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 30,
      match: /^[\p{L}\p{M}][\p{L}\p{M}' -]*$/u,
    },

    name: {
      type: String,
      required: true,
    },

    username: {
      type: String,
      unique: true,
      sparse: true,
      trim: true,
      lowercase: true,
      minlength: 3,
      maxlength: 20,
      match: /^[a-z0-9_]+$/,
      default: null,
    },

    usernameChangedAt: {
      type: Date,
      default: null,
    },

    nameChangedAt: {
      type: Date,
      default: null,
    },

    lastLoginAt: {
      type: Date,
      default: null,
    },

    pinnedPosts: {
      type: [mongoose.Schema.Types.ObjectId],
      ref: "Post",
      default: [],
    },

    openToCollabs: {
      type: Boolean,
      default: false,
    },

    isPrivate: {
      type: Boolean,
      default: false,
    },

    email: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
    },

    password: {
      type: String,
      required: true,
    },

    passwordChangedAt: {
      type: Date,
      default: null,
    },

    bio: {
      type: String,
      default: "",
      maxlength: 150,
    },

    profilePic: {
      type: String,
      default: "",
    },

    presenceVisibility: {
      type: String,
      enum: ["everyone", "followers", "nobody"],
      default: "everyone",
    },

    pushPrefs: {
      like: { type: Boolean, default: true },
      comment: { type: Boolean, default: true },
      follow: { type: Boolean, default: true },
      mention: { type: Boolean, default: true },
      reply: { type: Boolean, default: true },
      commentLike: { type: Boolean, default: true },
      repost: { type: Boolean, default: true },
      quote: { type: Boolean, default: true },
      reaction: { type: Boolean, default: true },
      message: { type: Boolean, default: true },
    },

    // Feature 6 — read receipts opt-out. true = show read receipts (default);
    // false = opt out, the "read" flag is still set DB-side but not surfaced.
    showReadReceipts: {
      type: Boolean,
      default: true,
    },

    // Feature 3 — Topics/Interests. 5–10 tags picked at or after signup.
    // Used by forYouService to weight interest-sourced candidates.
    interests: {
      type: [{ type: String, enum: AVAILABLE_TOPICS }],
      default: [],
    },

    // Feature 4 — Location for location-aware trending. City/region string,
    // user-provided and optional. Never used for targeting beyond hashtag trending.
    location: {
      type: String,
      default: "",
      trim: true,
      maxlength: 100,
    },

    // Feature 9 — Shadow-rank throttle. Set by moderation when a flagged account
    // should see reduced algorithmic reach without being suspended. Does NOT
    // hide posts — just demotes them in For You / Trending ranking.
    shadowRanked: {
      type: Boolean,
      default: false,
    },
    shadowRankedAt: {
      type: Date,
      default: null,
    },
    shadowRankedReason: {
      type: String,
      default: "",
      trim: true,
      maxlength: 500,
    },

    role: {
      type: String,
      enum: ["user", "moderator", "admin"],
      default: "user",
    },

    permissions: {
      type: [String],
      enum: [
        "manage_reports",
        "manage_users",
        "manage_content",
        "view_audit_log",
        "manage_roles",
        "manage_verification",
      ],
      default: [],
    },

    suspendedUntil: {
      type: Date,
      default: null,
    },
    banned: {
      type: Boolean,
      default: false,
    },
    restrictionReason: {
      type: String,
      default: "",
      trim: true,
      maxlength: 500,
    },

    strikes: [
      {
        reason: { type: String, default: "", trim: true, maxlength: 500 },
        moderator: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
          default: null,
        },
        reportId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Report",
          default: null,
        },
        createdAt: { type: Date, default: Date.now },
      },
    ],

    deletedAt: {
      type: Date,
      default: null,
      index: true,
    },

    followersCount: {
      type: Number,
      default: 0,
    },

    credibleRatio: {
      type: Number,
      default: 1,
    },

    lastPostAt: {
      type: Date,
      default: null,
    },
    recentHashtags: {
      type: [String],
      default: [],
    },

    verifications: [
      {
        type: { type: String, enum: VERIFICATION_TYPES, required: true },
        verifiedAt: { type: Date, default: Date.now },
        expiresAt: { type: Date, default: null },
        method: { type: String, default: "manual" },
        providerRef: { type: String, default: "" },
        entityName: { type: String, default: "", trim: true, maxlength: 120 },
        reviewedBy: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
          default: null,
        },
      },
    ],

    isVerified: { type: Boolean, default: false, index: true },
  },
  { timestamps: true },
);

userSchema.pre("validate", function () {
  if (this.firstName || this.lastName) {
    this.name = `${this.firstName || ""} ${this.lastName || ""}`.trim();
  }
});

userSchema.index({ name: 1 });
userSchema.index({ lastPostAt: -1 });
// Feature 4 — location-based trending lookup
userSchema.index({ location: 1 });

const User = mongoose.model("User", userSchema);

export default User;
