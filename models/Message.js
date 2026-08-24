import mongoose from "mongoose";

const messageSchema = new mongoose.Schema(
  {
    sender: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    receiver: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    // Additive, non-breaking: same two users as sender/receiver, just
    // also expressed as a set. Every existing read/write path
    // (controller, aggregation pipeline, sockets, Chat.jsx) still uses
    // sender/receiver directly and is untouched by this field — nothing
    // currently queries or relies on `participants`. It exists purely so
    // a future move to N-participant conversations doesn't have to
    // backfill this from sender+receiver on every historical message;
    // it's already sitting on each row, kept in sync automatically by
    // the pre-validate hook below.
    participants: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
      },
    ],
    text: {
      type: String,
      trim: true,
    },
    // Up to 4 images per message. New sends populate this array; the
    // legacy single `image` field below is kept for backward
    // compatibility with older messages that predate multi-image.
    images: {
      type: [String],
      default: [],
    },
    // Deprecated/legacy: single-image messages created before the
    // multi-image upgrade. New messages use `images` instead.
    image: {
      type: String,
      default: null,
    },
    // A chat video message. Mirrors Post.video: the browser uploads the
    // file directly to Cloudinary (signed via POST /messages/signature/video)
    // and the ready asset is stored here. Because the eager transform runs
    // synchronously inside the upload request, the URL is final by the time
    // the message is created — there is no "processing" state in practice.
    // Videos and images are mutually exclusive in a single message (a video
    // message has no `images`/`image` and vice-versa, matching posts).
    video: {
      publicId: { type: String, default: null },
      url: { type: String, default: null },
      thumbnailUrl: { type: String, default: null },
      durationSeconds: { type: Number, default: null },
      status: {
        type: String,
        enum: ["processing", "ready", "failed"],
        default: "ready",
      },
    },
    conversationId: {
      type: String,
      required: true,
      index: true,
    },
    read: {
      type: Boolean,
      default: false,
    },

    // Moderator soft-takedown (mirrors Post.removedAt). Removed messages
    // drop out of getMessages threads on the next read; both participants
    // are affected equally (moderation is not a per-recipient hide).
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
  },
  {
    timestamps: true,
  },
);

// Indexes
messageSchema.index({ sender: 1, receiver: 1 });
messageSchema.index({ conversationId: 1, createdAt: 1 });
messageSchema.index({ receiver: 1, read: 1 });
// Supports a future "all messages I'm part of" query directly against
// Message (participants) instead of only via the sender/receiver $or
// used today — not queried anywhere yet, but cheap to have ready.
messageSchema.index({ participants: 1 });

messageSchema.pre("validate", async function () {
  if (this.sender && this.receiver) {
    const participantIds = [
      this.sender.toString(),
      this.receiver.toString(),
    ].sort();
    this.conversationId = `${participantIds[0]}_${participantIds[1]}`;
    // Kept in lockstep with sender/receiver — never set independently by
    // callers, same pattern as conversationId above.
    this.participants = [this.sender, this.receiver];
  }
});

const Message = mongoose.model("Message", messageSchema);

export default Message;
