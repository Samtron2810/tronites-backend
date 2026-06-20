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

messageSchema.pre("validate", async function () {
  if (this.sender && this.receiver) {
    const participantIds = [
      this.sender.toString(),
      this.receiver.toString(),
    ].sort();
    this.conversationId = `${participantIds[0]}_${participantIds[1]}`;
  }
});

const Message = mongoose.model("Message", messageSchema);

export default Message;
