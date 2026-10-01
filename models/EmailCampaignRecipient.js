import mongoose from "mongoose";

// One row per (campaign, user), snapshotted when the campaign is created so
// later bans/deletions/opt-outs never change who a running send targets
// mid-flight, and so the send is resumable after a restart.
const recipientSchema = new mongoose.Schema(
  {
    campaign: { type: mongoose.Schema.Types.ObjectId, ref: "EmailCampaign", required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    email: { type: String, required: true },
    firstName: { type: String, default: "" },
    status: {
      type: String,
      enum: ["pending", "sending", "sent", "failed", "cancelled"],
      default: "pending",
    },
    attempts: { type: Number, default: 0 },
    claimedAt: { type: Date, default: null },
    sentAt: { type: Date, default: null },
    error: { type: String, default: "", maxlength: 300 },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

recipientSchema.index({ campaign: 1, status: 1, _id: 1 });
recipientSchema.index({ status: 1, sentAt: -1 });
// Per-recipient rows are operational data, not a record — drop after 90 days.
recipientSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

export default mongoose.model("EmailCampaignRecipient", recipientSchema);
