import mongoose from "mongoose";
import { BROADCAST_GROUPS, BROADCAST_TYPES } from "../utils/broadcastGroups.js";

export const CAMPAIGN_STATUSES = [
  "preparing", // recipients are being snapshotted
  "queued",
  "sending",
  "paused", // provider quota/rate limit hit — resumable
  "completed",
  "cancelled",
  "failed",
];

const emailCampaignSchema = new mongoose.Schema(
  {
    subject: { type: String, required: true, trim: true, maxlength: 150 },
    body: { type: String, required: true, maxlength: 5000 },
    ctaLabel: { type: String, default: "", trim: true, maxlength: 40 },
    ctaUrl: { type: String, default: "", trim: true, maxlength: 500 },

    // announcement → respects marketingEmailOptOut + carries an unsubscribe
    // link. critical → ignores opt-out (policy changes, security notices).
    type: { type: String, enum: BROADCAST_TYPES, default: "announcement" },

    audience: {
      groups: { type: [{ type: String, enum: BROADCAST_GROUPS }], default: [] },
      userIds: { type: [mongoose.Schema.Types.ObjectId], default: [] },
    },

    status: { type: String, enum: CAMPAIGN_STATUSES, default: "preparing", index: true },
    recipientCount: { type: Number, default: 0 },
    sentCount: { type: Number, default: 0 },
    failedCount: { type: Number, default: 0 },
    lastError: { type: String, default: "" },

    createdBy: {
      _id: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
      name: { type: String, default: "" },
      username: { type: String, default: null },
    },

    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

emailCampaignSchema.index({ createdAt: -1 });

export default mongoose.model("EmailCampaign", emailCampaignSchema);
