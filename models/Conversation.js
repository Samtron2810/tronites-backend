import mongoose from "mongoose";

const conversationSchema = new mongoose.Schema(
  {
    // Sorted-pair id, same format as Message.conversationId, so both
    // collections can be joined/looked-up consistently.
    conversationId: {
      type: String,
      required: true,
      unique: true,
    },
    participants: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true,
      },
    ],
    status: {
      type: String,
      enum: ["pending", "accepted", "declined"],
      required: true,
      default: "pending",
    },
    initiator: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  { timestamps: true },
);

conversationSchema.index({ participants: 1 });
conversationSchema.index({ status: 1 });

const Conversation = mongoose.model("Conversation", conversationSchema);

export default Conversation;
