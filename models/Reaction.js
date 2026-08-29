import mongoose from "mongoose";

// 1.2 — emoji reactions on posts and messages. One row per
// (user, targetType, targetId), same edge-collection pattern as
// Like/CommentLike/Bookmark/Repost. Polymorphic (targetType + targetId)
// rather than two separate collections (PostReaction/MessageReaction)
// because the two surfaces share 100% of the same shape and queries —
// a second collection would just be this one, copy-pasted.
export const REACTION_EMOJIS = ["❤️", "😂", "😮", "😢", "😡", "👍"];

const reactionSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    targetType: {
      type: String,
      enum: ["post", "message"],
      required: true,
    },
    targetId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },
    emoji: {
      type: String,
      enum: REACTION_EMOJIS,
      required: true,
    },
  },
  { timestamps: true },
);

// One reaction per (user, target) — picking a new emoji replaces the
// old one rather than stacking a second row. Enforced here (not just
// in the controller) for race-safety, same as every other edge model.
reactionSchema.index(
  { user: 1, targetType: 1, targetId: 1 },
  { unique: true },
);
// Fast "reactions on this target" (grouped-by-emoji summary + full list).
reactionSchema.index({ targetType: 1, targetId: 1, createdAt: -1 });
// Fast "this user's reactions" — account deletion cascade.
reactionSchema.index({ user: 1, createdAt: -1 });

const Reaction = mongoose.model("Reaction", reactionSchema);

export default Reaction;
