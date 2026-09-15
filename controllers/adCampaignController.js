import crypto from "crypto";
import AdCampaign from "../models/AdCampaign.js";
import Post from "../models/Post.js";
import { canPromote } from "../utils/tierLimits.js";
import {
  initializeTransaction,
  verifyTransaction,
} from "../services/paystackService.js";
import { PROMO_TIERS, CTA_TYPES } from "./promotedPostController.js";
import { invalidateFeedCache, invalidateCache } from "../utils/redis.js";

const CAMPAIGN_REFERENCE_PREFIX = "tronites_camp_";
const MAX_POSTS_PER_CAMPAIGN = 10;

// GET /api/campaigns — paginated list of user's campaigns
export const listCampaigns = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(20, parseInt(req.query.limit) || 10);
    const skip = (page - 1) * limit;

    const [campaigns, total] = await Promise.all([
      AdCampaign.find({ user: req.user._id })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      AdCampaign.countDocuments({ user: req.user._id }),
    ]);

    res.status(200).json({ campaigns, total, page, limit });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// GET /api/campaigns/:id
export const getCampaign = async (req, res) => {
  try {
    const campaign = await AdCampaign.findOne({
      _id: req.params.id,
      user: req.user._id,
    })
      .populate("posts.postId", "text images video createdAt promotionImpressions promotionClicks ctaClicks ctaType destinationUrl likesCount commentsCount repostsCount")
      .lean();

    if (!campaign) return res.status(404).json({ message: "Campaign not found." });
    res.status(200).json({ campaign });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// POST /api/campaigns — create a new campaign (draft)
export const createCampaign = async (req, res) => {
  try {
    if (!canPromote(req.user)) {
      return res.status(403).json({
        message: "Ad campaigns are available to verified business accounts only.",
        code: "CAMPAIGN_UNAVAILABLE",
      });
    }

    const {
      name,
      postIds = [],
      tier = "basic",
      targeting = {},
      scheduledStart = null,
      scheduledEnd = null,
      ctaType = null,
      destinationUrl = null,
    } = req.body;

    if (!name?.trim()) return res.status(400).json({ message: "Campaign name is required." });
    if (!PROMO_TIERS[tier]) return res.status(400).json({ message: `Invalid tier: ${tier}` });
    if (postIds.length === 0) return res.status(400).json({ message: "At least one post is required." });
    if (postIds.length > MAX_POSTS_PER_CAMPAIGN) {
      return res.status(400).json({ message: `Max ${MAX_POSTS_PER_CAMPAIGN} posts per campaign.` });
    }
    if (ctaType && !CTA_TYPES.includes(ctaType)) {
      return res.status(400).json({ message: `Invalid CTA type: ${ctaType}` });
    }
    if (destinationUrl) {
      try { new URL(destinationUrl); }
      catch { return res.status(400).json({ message: "Destination URL must be a valid URL." }); }
    }

    // Verify all posts belong to the requester and are eligible
    const posts = await Post.find({
      _id: { $in: postIds },
      user: req.user._id,
      removedAt: null,
    }).select("_id");

    if (posts.length !== postIds.length) {
      return res.status(400).json({ message: "One or more posts are invalid or do not belong to you." });
    }

    const tierConfig = PROMO_TIERS[tier];
    const totalBudgetNgn = tierConfig.amountNgn * postIds.length;

    const campaign = await AdCampaign.create({
      user: req.user._id,
      name: name.trim(),
      status: "draft",
      posts: postIds.map((id) => ({ postId: id })),
      tier,
      targeting: {
        location: targeting.location || "",
        interests: Array.isArray(targeting.interests) ? targeting.interests : [],
      },
      totalBudgetNgn,
      scheduledStart: scheduledStart ? new Date(scheduledStart) : null,
      scheduledEnd: scheduledEnd ? new Date(scheduledEnd) : null,
      ctaType: ctaType || null,
      destinationUrl: destinationUrl || null,
    });

    res.status(201).json({ campaign });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// PUT /api/campaigns/:id — update draft campaign
export const updateCampaign = async (req, res) => {
  try {
    const campaign = await AdCampaign.findOne({
      _id: req.params.id,
      user: req.user._id,
    });
    if (!campaign) return res.status(404).json({ message: "Campaign not found." });
    if (campaign.status !== "draft") {
      return res.status(409).json({ message: "Only draft campaigns can be edited." });
    }

    const { name, postIds, tier, targeting, scheduledStart, scheduledEnd, ctaType, destinationUrl } = req.body;

    if (name !== undefined) campaign.name = name.trim();
    if (tier !== undefined) {
      if (!PROMO_TIERS[tier]) return res.status(400).json({ message: `Invalid tier: ${tier}` });
      campaign.tier = tier;
    }
    if (targeting !== undefined) {
      campaign.targeting = {
        location: targeting.location || "",
        interests: Array.isArray(targeting.interests) ? targeting.interests : [],
      };
    }
    if (ctaType !== undefined) {
      if (ctaType && !CTA_TYPES.includes(ctaType)) {
        return res.status(400).json({ message: `Invalid CTA type: ${ctaType}` });
      }
      campaign.ctaType = ctaType || null;
    }
    if (destinationUrl !== undefined) {
      if (destinationUrl) {
        try { new URL(destinationUrl); }
        catch { return res.status(400).json({ message: "Destination URL must be a valid URL." }); }
      }
      campaign.destinationUrl = destinationUrl || null;
    }
    if (scheduledStart !== undefined) campaign.scheduledStart = scheduledStart ? new Date(scheduledStart) : null;
    if (scheduledEnd !== undefined) campaign.scheduledEnd = scheduledEnd ? new Date(scheduledEnd) : null;

    if (postIds !== undefined) {
      if (postIds.length === 0) return res.status(400).json({ message: "At least one post is required." });
      if (postIds.length > MAX_POSTS_PER_CAMPAIGN) {
        return res.status(400).json({ message: `Max ${MAX_POSTS_PER_CAMPAIGN} posts per campaign.` });
      }
      const posts = await Post.find({
        _id: { $in: postIds },
        user: req.user._id,
        removedAt: null,
      }).select("_id");
      if (posts.length !== postIds.length) {
        return res.status(400).json({ message: "One or more posts are invalid." });
      }
      campaign.posts = postIds.map((id) => ({ postId: id }));
    }

    // Recalculate budget
    const tierConfig = PROMO_TIERS[campaign.tier];
    campaign.totalBudgetNgn = tierConfig.amountNgn * campaign.posts.length;

    await campaign.save();
    res.status(200).json({ campaign });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// POST /api/campaigns/:id/pay — initiate Paystack payment for the campaign
export const initiateCampaignPayment = async (req, res) => {
  try {
    if (!canPromote(req.user)) {
      return res.status(403).json({ message: "Business accounts only." });
    }

    const campaign = await AdCampaign.findOne({
      _id: req.params.id,
      user: req.user._id,
    });
    if (!campaign) return res.status(404).json({ message: "Campaign not found." });
    if (campaign.status !== "draft") {
      return res.status(409).json({ message: "Campaign has already been paid for or is not a draft." });
    }
    if (campaign.paymentReference) {
      return res.status(409).json({ message: "A payment is already pending for this campaign." });
    }

    const owner = await import("../models/User.js").then((m) =>
      m.default.findById(req.user._id).select("email"),
    );

    const reference = `${CAMPAIGN_REFERENCE_PREFIX}${crypto.randomBytes(12).toString("hex")}`;
    const callbackBase =
      process.env.PAYSTACK_PROMO_CALLBACK_URL ||
      process.env.PAYSTACK_CALLBACK_URL;
    const callbackUrl = callbackBase
      ? `${callbackBase.replace(/\/$/, "")}?paystack_ref=${reference}&type=campaign`
      : undefined;

    const paystackData = await initializeTransaction({
      email: owner.email,
      amountKobo: campaign.totalBudgetNgn * 100,
      reference,
      metadata: {
        userId: req.user._id.toString(),
        campaignId: campaign._id.toString(),
        platform: "tronites",
      },
      callbackUrl,
    });

    campaign.paymentReference = reference;
    campaign.paymentStatus = "pending";
    await campaign.save();

    res.status(200).json({
      reference,
      authorizationUrl: paystackData.authorization_url,
      amountNgn: campaign.totalBudgetNgn,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// GET /api/campaigns/:id/verify — verify campaign payment and activate
export const verifyCampaignPayment = async (req, res) => {
  try {
    const campaign = await AdCampaign.findOne({
      _id: req.params.id,
      user: req.user._id,
    });
    if (!campaign) return res.status(404).json({ message: "Campaign not found." });
    if (!campaign.paymentReference) {
      return res.status(409).json({ message: "No pending payment for this campaign." });
    }

    const data = await verifyTransaction(campaign.paymentReference);
    if (data.status !== "success") {
      return res.status(402).json({
        message: `Payment not successful (status: ${data.status}).`,
      });
    }

    await activateCampaign(campaign);

    res.status(200).json({ verified: true, status: campaign.status });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

// Internal: activate campaign posts after payment success
export const activateCampaign = async (campaign) => {
  const tierConfig = PROMO_TIERS[campaign.tier] || PROMO_TIERS.basic;
  const now = new Date();
  const promotedFrom = campaign.scheduledStart && new Date(campaign.scheduledStart) > now
    ? new Date(campaign.scheduledStart)
    : now;
  const promotedUntil = new Date(
    promotedFrom.getTime() + tierConfig.days * 24 * 60 * 60 * 1000,
  );

  // Activate all posts
  await Promise.all(
    campaign.posts.map(async (entry) => {
      await Post.updateOne(
        { _id: entry.postId },
        {
          $set: {
            promotedUntil,
            promotionTier: campaign.tier,
            promotionTargeting: campaign.targeting,
            promotionImpressions: 0,
            promotionClicks: 0,
            promotionReference: null,
            campaignId: campaign._id,
            ctaType: campaign.ctaType || null,
            destinationUrl: campaign.destinationUrl || null,
          },
        },
      );
      entry.status = "active";
      entry.promotedFrom = promotedFrom;
      entry.promotedUntil = promotedUntil;
    }),
  );

  campaign.status = "active";
  campaign.paymentStatus = "paid";
  campaign.amountPaidNgn = campaign.totalBudgetNgn;
  campaign.paymentReference = null;
  await campaign.save();

  invalidateFeedCache(campaign.user).catch(() => {});
  invalidateCache(`profile-posts:${campaign.user}:*`).catch(() => {});
};

// GET /api/campaigns/:id/export — CSV spend/performance export
export const exportCampaignReport = async (req, res) => {
  try {
    const campaign = await AdCampaign.findOne({
      _id: req.params.id,
      user: req.user._id,
    })
      .populate("posts.postId", "text createdAt promotionImpressions promotionClicks likesCount commentsCount repostsCount")
      .lean();
    if (!campaign) return res.status(404).json({ message: "Campaign not found." });

    const tierConfig = PROMO_TIERS[campaign.tier] || PROMO_TIERS.basic;
    const costPerPost = tierConfig.amountNgn;

    const rows = [
      ["Campaign", campaign.name],
      ["Tier", campaign.tier],
      ["Total Spend (NGN)", campaign.amountPaidNgn],
      ["Status", campaign.status],
      ["Total Impressions", campaign.impressions],
      ["Total Clicks", campaign.clicks],
      ["Total Engagements", campaign.engagements],
      [""],
      ["Post ID", "Snippet", "Impressions", "Clicks", "Likes", "Comments", "Reposts", "Cost (NGN)"],
    ];

    campaign.posts.forEach((entry) => {
      const p = entry.postId;
      if (!p) return;
      const snippet = typeof p.text === "string" ? p.text.slice(0, 60).replace(/"/g, "'") : "";
      rows.push([
        p._id.toString(),
        `"${snippet}"`,
        p.promotionImpressions ?? 0,
        p.promotionClicks ?? 0,
        p.likesCount ?? 0,
        p.commentsCount ?? 0,
        p.repostsCount ?? 0,
        costPerPost,
      ]);
    });

    const csv = rows.map((r) => r.join(",")).join("\n");

    res.setHeader("Content-Type", "text/csv");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="campaign-${campaign._id}-report.csv"`,
    );

    // Update last export timestamp
    await AdCampaign.updateOne({ _id: campaign._id }, { $set: { lastExportAt: new Date() } });

    res.status(200).send(csv);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// DELETE /api/campaigns/:id — cancel a draft or active campaign
export const cancelCampaign = async (req, res) => {
  try {
    const campaign = await AdCampaign.findOne({
      _id: req.params.id,
      user: req.user._id,
    });
    if (!campaign) return res.status(404).json({ message: "Campaign not found." });
    if (!["draft", "active", "paused"].includes(campaign.status)) {
      return res.status(409).json({ message: "Campaign cannot be cancelled in its current state." });
    }

    // If active, remove promotion from all posts
    if (campaign.status === "active") {
      await Post.updateMany(
        { campaignId: campaign._id },
        {
          $set: {
            promotedUntil: null,
            campaignId: null,
            promotionTier: null,
            ctaType: null,
            destinationUrl: null,
          },
        },
      );
      invalidateFeedCache(req.user._id).catch(() => {});
    }

    campaign.status = "cancelled";
    await campaign.save();

    res.status(200).json({ cancelled: true });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
