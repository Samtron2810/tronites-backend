import mongoose from "mongoose";

// Ad campaign — a named collection of promoted posts with a shared budget
// and schedule. Only business-tier users can create campaigns.
const adCampaignSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
    },

    status: {
      type: String,
      enum: ["draft", "active", "paused", "completed", "cancelled"],
      default: "draft",
    },

    // Posts included in this campaign. Each post gets its own promotion
    // window derived from the campaign schedule. Max 10 posts per campaign.
    posts: [
      {
        postId: { type: mongoose.Schema.Types.ObjectId, ref: "Post", required: true },
        // Per-post promotion reference (mirrors Post.promotionReference)
        promotionReference: { type: String, default: null },
        // Per-post promotion window (may differ if staggered)
        promotedFrom: { type: Date, default: null },
        promotedUntil: { type: Date, default: null },
        status: {
          type: String,
          enum: ["pending", "active", "expired"],
          default: "pending",
        },
      },
    ],

    // Promotion tier selected for all posts in this campaign.
    // Tiers define price and duration (see promotedPostController PROMO_TIERS).
    tier: {
      type: String,
      enum: ["basic", "standard", "premium"],
      default: "basic",
    },

    // Audience targeting — all filters are optional. When absent, post is
    // shown to all users (same as old flat promotion).
    targeting: {
      location: { type: String, default: "", trim: true, maxlength: 100 },
      interests: { type: [String], default: [] },
    },

    // Total budget in NGN (sum of all per-post charges).
    totalBudgetNgn: { type: Number, default: 0 },
    amountPaidNgn: { type: Number, default: 0 },

    // Paystack reference for the campaign-level charge (single payment for all posts).
    paymentReference: { type: String, default: null },
    paymentStatus: {
      type: String,
      enum: ["unpaid", "pending", "paid", "refunded"],
      default: "unpaid",
    },

    // Aggregate impression + engagement counters across all posts in campaign.
    impressions: { type: Number, default: 0 },
    clicks: { type: Number, default: 0 },
    engagements: { type: Number, default: 0 }, // likes + comments + reposts

    // Campaign schedule — when to start/end. Null = immediately / no hard end.
    scheduledStart: { type: Date, default: null },
    scheduledEnd: { type: Date, default: null },

    // Spend export — last time a CSV was requested (for rate limiting).
    lastExportAt: { type: Date, default: null },
  },
  { timestamps: true },
);

adCampaignSchema.index({ user: 1, createdAt: -1 });
adCampaignSchema.index({ paymentReference: 1 }, { sparse: true });
adCampaignSchema.index({ status: 1 });

const AdCampaign = mongoose.model("AdCampaign", adCampaignSchema);
export default AdCampaign;
