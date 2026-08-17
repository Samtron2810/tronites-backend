import mongoose from "mongoose";

const userSchema = new mongoose.Schema(
  {
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

    bio: {
      type: String,
      default: "",
      maxlength: 150,
    },

    profilePic: {
      type: String,
      default: "",
    },
  },
  { timestamps: true },
);

// Indexes (email is already indexed via `unique: true` in the schema)
userSchema.index({ name: 1 });

const User = mongoose.model("User", userSchema);

export default User;
