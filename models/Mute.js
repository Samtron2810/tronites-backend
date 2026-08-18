import mongoose from "mongoose";

// Muting is one-directional and silent: A mutes B means A stops seeing
// B's posts/reposts in A's own feed, and stops getting notifications
// triggered by B (likes, comments, follows, mentions). B is not told,
// B's own view of everything is completely unaffected, and B can still
// follow/message/comment on A same as before — this is a personal feed
// filter, not a restriction on the muted person. That's what
// distinguishes it from Block, which is mutual-visible and actually
// restricts the blocked user's ability to interact.
const muteSchema = new mongoose.Schema(
  {
    muter: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    muted: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  { timestamps: true },
);

muteSchema.index({ muter: 1, muted: 1 }, { unique: true });
muteSchema.index({ muted: 1 });

const Mute = mongoose.model("Mute", muteSchema);

export default Mute;
