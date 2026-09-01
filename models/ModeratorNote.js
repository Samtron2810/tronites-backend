import mongoose from "mongoose";

// Phase 7 (roadmap 3.6) — free-text internal notes moderators leave on a
// user account, independent of any single report/strike/restriction.
// Mirrors the Follow/Mute/Block edge-collection convention: a thin
// collection with an indexed pointer to the subject, not an embedded
// array on User (keeps User lean and avoids unbounded document growth on
// heavily-moderated accounts).
//
// Never shown to the subject — moderator-only, same visibility class as
// User.restrictionReason and strikes[].reason.
const moderatorNoteSchema = new mongoose.Schema(
  {
    // The account this note is about.
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    author: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    body: {
      type: String,
      required: true,
      trim: true,
      maxlength: 1000,
    },
  },
  { timestamps: true },
);

// Case-history read: all notes on a user, newest first.
moderatorNoteSchema.index({ user: 1, createdAt: -1 });

const ModeratorNote = mongoose.model("ModeratorNote", moderatorNoteSchema);

export default ModeratorNote;
