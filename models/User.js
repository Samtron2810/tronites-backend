import mongoose from "mongoose";

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
    },

    email: {
      type: String,
      required: true,
      unique: true,
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
