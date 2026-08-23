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
    image: {
      type: String,
      default: null,
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
