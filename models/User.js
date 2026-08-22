import mongoose from "mongoose";

const userSchema = new mongoose.Schema(
  {
    firstName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 30,
      match: /^[A-Za-z]+$/,
    },

    lastName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 30,
      match: /^[A-Za-z]+$/,
    },

    // Derived display name (`${firstName} ${lastName}`), stored so every
    // existing read site (DTOs, search index, mention suggestions, etc.)
    // keeps working unchanged. Kept in sync in the pre-save hook below —
    // never set directly by callers.
    name: {
      type: String,
      required: true,
    },

    // Nullable until the post-signup "choose your username" step
    // completes — null means the account exists but onboarding isn't
    // finished. sparse:true lets multiple docs have null without
    // violating the unique index.
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

    // Set whenever the password is changed (reset flow). The auth
    // middleware compares each JWT's `iat` against this timestamp: any
    // token issued before the change is rejected, which invalidates all
    // existing sessions (including stolen cookies) after a reset.
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

    // Who can see this user's online/offline status. "everyone" matches
    // the historical (pre-P0.7) behavior. "followers" limits it to
    // people this user follows back — i.e. connections, not just anyone
    // who chose to follow them. "nobody" hides it from all other users
    // entirely, including mutuals. Default stays "everyone" so existing
    // users see no behavior change unless they opt into more privacy.
    presenceVisibility: {
      type: String,
      enum: ["everyone", "followers", "nobody"],
      default: "everyone",
    },

    // Gates the moderation queue (list/resolve reports). Only ever set
    // directly in the database or by an existing admin via a future
    // admin tool — there is no self-service endpoint that changes this,
    // so a compromised or malicious regular account can never grant
    // itself moderator access through the API.
    role: {
      type: String,
      enum: ["user", "moderator", "admin"],
      default: "user",
    },
  },
  { timestamps: true },
);

// Keep `name` derived from firstName/lastName on every save, so nothing
// downstream (DTOs, text search, sockets) needs to know the split exists.
userSchema.pre("validate", function () {
  if (this.firstName || this.lastName) {
    this.name = `${this.firstName || ""} ${this.lastName || ""}`.trim();
  }
});

// Indexes (email is already indexed via `unique: true` in the schema)
userSchema.index({ name: 1 });

const User = mongoose.model("User", userSchema);

export default User;
