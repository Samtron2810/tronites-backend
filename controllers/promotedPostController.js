import crypto from "crypto";
import Post from "../models/Post.js";
import User from "../models/User.js";
import AdCampaign from "../models/AdCampaign.js";
import { canPromote } from "../utils/tierLimits.js";
import {
  initializeTransaction,
  verifyTransaction,
} from "../services/paystackService.js";
import { invalidateCache, invalidateFeedCache } from "../utils/redis.js";

// ── Promotion tiers ──────────────────────────────────────────────────────────
// Each tier defines price (NGN), promotion duration, and daily impression cap.
// All three are env-overridable per tier.
export const PROMO_TIERS = {
  basic: {
    amountNgn: Number(process.env.PROMO_BASIC_NGN) || 2000,
    days: Number(process.env.PROMO_BASIC_DAYS) || 3,
    label: "Basic (3 days)",
    impressionCap: 5000,
  },
  standard: {
    amountNgn: Number(process.env.PROMO_STANDARD_NGN) || 5000,
    days: Number(process.env.PROMO_STANDARD_DAYS) || 7,
    label: "Standard (7 days)",
    impressionCap: 20000,
  },
  premium: {
    amountNgn: Number(process.env.PROMO_PREMIUM_NGN) || 15000,
    days: Number(process.env.PROMO_PREMIUM_DAYS) || 14,
    label: "Premium (14 days)",
    impressionCap: null, // unlimited
  },
};

const PROMO_REFERENCE_PREFIX = "tronites_promo_";

export const CTA_TYPES = [
  "learn_more", "shop_now", "sign_up", "contact_us",
  "download", "get_quote", "visit_website", "book_now",
];

// GET /posts/promote/fees
export const getPromotionFees = async (_req, res) => {
  try {
    res.status(200).json({ tiers: PROMO_TIERS });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// POST /posts/promote/initiate { postId, tier, targeting? }
export const initiatePromotion = async (req, res) => {
  try {
    if (!canPromote(req.user)) {
      return res.status(403).json({
        message: "Promoted posts are available to verified business accounts only.",
        code: "PROMOTING_UNAVAILABLE",
      });
    }

    const { postId, tier = "basic", targeting = {}, ctaType = null, destinationUrl = null } = req.body;

    const tierConfig = PROMO_TIERS[tier];
    if (!tierConfig) {
      return res.status(400).json({ message: `Invalid promotion tier: ${tier}` });
    }
    if (ctaType && !CTA_TYPES.includes(ctaType)) {
      return res.status(400).json({ message: `Invalid CTA type: ${ctaType}` });
    }
    if (destinationUrl) {
      try { new URL(destinationUrl); }
      catch { return res.status(400).json({ message: "Destination URL must be a valid URL." }); }
    }

    const post = await Post.findById(postId).select(
      "user removedAt promotedUntil promotionReference",
    );
    if (!post || post.removedAt) {
      return res.status(404).json({ message: "Post not found." });
    }
    if (post.user.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: "You can only promote your own posts." });
    }
    if (post.promotedUntil && new Date(post.promotedUntil) > new Date()) {
      return res.status(409).json({
        message: "This post is already promoted.",
        promotedUntil: post.promotedUntil,
      });
    }
    if (post.promotionReference) {
      return res.status(409).json({
        message: "A promotion payment for this post is already pending verification.",
      });
    }

    const owner = await User.findById(req.user._id).select("email");
    if (!owner) return res.status(404).json({ message: "User not found." });

    const reference = `${PROMO_REFERENCE_PREFIX}${crypto.randomBytes(12).toString("hex")}`;

    const callbackBase =
      process.env.PAYSTACK_PROMO_CALLBACK_URL ||
      process.env.PAYSTACK_CALLBACK_URL;
    const callbackUrl = callbackBase
      ? `${callbackBase.replace(/\/$/, "")}?paystack_ref=${reference}`
      : undefined;

    const paystackData = await initializeTransaction({
      email: owner.email,
      amountKobo: tierConfig.amountNgn * 100,
      reference,
      metadata: {
        userId: req.user._id.toString(),
        postId: post._id.toString(),
        tier,
        targeting,
        platform: "tronites",
      },
      callbackUrl,
    });

    // Stamp reference + tier + targeting before redirect so retry guards work.
    await post.updateOne({
      $set: {
        promotionReference: reference,
        promotionTier: tier,
        promotionTargeting: {
          location: targeting.location || "",
          interests: Array.isArray(targeting.interests) ? targeting.interests : [],
        },
        ctaType: ctaType || null,
        destinationUrl: destinationUrl || null,
      },
    });

    res.status(200).json({
      reference,
      authorizationUrl: paystackData.authorization_url,
      tier,
      amountNgn: tierConfig.amountNgn,
      promoDays: tierConfig.days,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// GET /posts/promote/verify/:reference
export const verifyPromotion = async (req, res) => {
  try {
    const { reference } = req.params;
    const post = await Post.findOne({
      user: req.user._id,
      promotionReference: reference,
    });
    if (!post) {
      return res.status(404).json({ message: "Promotion payment not found." });
    }

    const data = await verifyTransaction(reference);
    if (data.status !== "success") {
      return res.status(402).json({
        message: `Payment not successful (status: ${data.status}). Please try again.`,
      });
    }

    const tier = post.promotionTier || "basic";
    const tierConfig = PROMO_TIERS[tier] || PROMO_TIERS.basic;
    const promotedUntil = new Date(
      Date.now() + tierConfig.days * 24 * 60 * 60 * 1000,
    );

    await post.updateOne({
      $set: {
        promotedUntil,
        promotionReference: null,
        promotionImpressions: 0,
        promotionClicks: 0,
      },
    });

    invalidateFeedCache(req.user._id);
    invalidateCache(`profile-posts:${req.user._id}:*`);

    res.status(200).json({ verified: true, promotedUntil, tier });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

// DELETE /posts/promote/cancel/:postId
export const cancelPromotion = async (req, res) => {
  try {
    const { postId } = req.params;
    const post = await Post.findById(postId).select(
      "user removedAt promotedUntil promotionReference",
    );
    if (!post || post.removedAt) {
      return res.status(404).json({ message: "Post not found." });
    }
    if (post.user.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: "You can only cancel your own post's promotion." });
    }
    if (post.promotedUntil && new Date(post.promotedUntil) > new Date()) {
      return res.status(409).json({
        message: "This post is already promoted and cannot be cancelled.",
        promotedUntil: post.promotedUntil,
      });
    }
    if (!post.promotionReference) {
      return res.status(409).json({ message: "No pending promotion to cancel." });
    }

    await post.updateOne({ $set: { promotionReference: null } });
    res.status(200).json({ cancelled: true });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// GET /posts/promote/my-promotions
export const getMyPromotions = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(20, parseInt(req.query.limit) || 10);
    const skip = (page - 1) * limit;
    const now = new Date();

    const filter = {
      user: req.user._id,
      removedAt: null,
      $or: [
        { promotedUntil: { $ne: null } },
        { promotionReference: { $ne: null } },
      ],
    };

    const [posts, total] = await Promise.all([
      Post.find(filter)
        .select(
          "text images video createdAt promotedUntil promotionReference promotionTier promotionTargeting promotionImpressions promotionClicks ctaClicks ctaType destinationUrl likesCount commentsCount repostsCount",
        )
        .sort({ updatedAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Post.countDocuments(filter),
    ]);

    const promotions = posts.map((p) => {
      let status;
      if (p.promotionReference && (!p.promotedUntil || new Date(p.promotedUntil) <= now)) {
        status = "pending";
      } else if (p.promotedUntil && new Date(p.promotedUntil) > now) {
        status = "active";
      } else {
        status = "expired";
      }

      const tierConfig = PROMO_TIERS[p.promotionTier] || null;
      const impressionCap = tierConfig?.impressionCap ?? null;
      const reachPct =
        impressionCap && p.promotionImpressions
          ? Math.min(100, Math.round((p.promotionImpressions / impressionCap) * 100))
          : null;

      return {
        _id: p._id,
        text: p.text,
        images: p.images,
        video: p.video,
        createdAt: p.createdAt,
        promotedUntil: p.promotedUntil,
        promotionReference: p.promotionReference,
        promotionTier: p.promotionTier,
        promotionTargeting: p.promotionTargeting,
        impressions: p.promotionImpressions ?? 0,
        clicks: p.promotionClicks ?? 0,
        ctaClicks: p.ctaClicks ?? 0,
        ctaType: p.ctaType ?? null,
        destinationUrl: p.destinationUrl ?? null,
        impressionCap,
        reachPct,
        likesCount: p.likesCount,
        commentsCount: p.commentsCount,
        repostsCount: p.repostsCount,
        status,
      };
    });

    res.status(200).json({ promotions, total, page, limit });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// POST /posts/promote/impression/:postId  — called by the feed when a
// promoted post enters the viewport. Increments promotionImpressions and
// also propagates to AdCampaign.impressions if the post is in a campaign.
export const recordImpression = async (req, res) => {
  try {
    const { postId } = req.params;
    const post = await Post.findById(postId).select(
      "promotedUntil promotionTier promotionImpressions campaignId",
    );

    if (!post || !post.promotedUntil || new Date(post.promotedUntil) <= new Date()) {
      return res.status(200).json({ ok: true }); // silently ignore organic/expired
    }

    // Respect impression cap
    const tierConfig = PROMO_TIERS[post.promotionTier] || PROMO_TIERS.basic;
    if (
      tierConfig.impressionCap !== null &&
      (post.promotionImpressions ?? 0) >= tierConfig.impressionCap
    ) {
      return res.status(200).json({ ok: true, capped: true });
    }

    await Post.updateOne({ _id: postId }, { $inc: { promotionImpressions: 1 } });

    if (post.campaignId) {
      await AdCampaign.updateOne(
        { _id: post.campaignId },
        { $inc: { impressions: 1 } },
      ).catch(() => {}); // non-fatal
    }

    res.status(200).json({ ok: true });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// POST /posts/promote/click/:postId — records a sponsored-post click.
export const recordClick = async (req, res) => {
  try {
    const { postId } = req.params;
    await Post.updateOne(
      { _id: postId, promotedUntil: { $gt: new Date() } },
      { $inc: { promotionClicks: 1 } },
    );
    res.status(200).json({ ok: true });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// POST /posts/promote/cta-click/:postId — records a CTA-button click-through.
// Separate metric from recordClick (whole-card sponsored click) and from
// organic engagement (likes/comments/reposts) — this is specifically
// "did the ad's call-to-action convert a click".
export const recordCtaClick = async (req, res) => {
  try {
    const { postId } = req.params;
    const post = await Post.updateOne(
      { _id: postId, promotedUntil: { $gt: new Date() } },
      { $inc: { ctaClicks: 1 } },
    );

    const p = await Post.findById(postId).select("campaignId destinationUrl ctaType");
    if (p?.campaignId) {
      await AdCampaign.updateOne(
        { _id: p.campaignId },
        { $inc: { ctaClicks: 1 } },
      ).catch(() => {}); // non-fatal
    }

    res.status(200).json({ ok: true, destinationUrl: p?.destinationUrl || null });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// GET /posts/promote/promoted — feed injection (unchanged public API).
// Now also filters by targeting.location and targeting.interests when set.
export const getPromotedPostsForFeed = async (
  excludeIds = [],
  { viewerId, blockedIds = new Set(), mutedIds = new Set(), viewerLocation = "", viewerInterests = [] } = {},
) => {
  const now = new Date();
  const excludedUsers = new Set([...blockedIds, ...mutedIds]);

  const publicFilter = {
    $or: [{ privacy: "public" }, { privacy: { $exists: false } }],
  };

  const query = {
    promotedUntil: { $gt: now },
    removedAt: null,
    ...publicFilter,
    ...(excludeIds.length ? { _id: { $nin: excludeIds } } : {}),
    ...(excludedUsers.size ? { user: { $nin: [...excludedUsers] } } : {}),
  };

  if (viewerId) {
    query.user = query.user
      ? { ...query.user, $ne: viewerId }
      : { $ne: viewerId };
  }

  // Fetch pool of candidates and soft-filter by targeting. We fetch more
  // than 3 to have candidates after filtering, then cap at 3.
  const candidates = await Post.find(query)
    .populate("user", "name username profilePic verifications isVerified")
    .sort({ promotedUntil: -1 })
    .limit(20)
    .lean();

  // Apply targeting soft-filters (location + interests).
  const filtered = candidates.filter((p) => {
    const t = p.promotionTargeting;
    if (!t) return true;

    // Location match — case-insensitive substring
    if (t.location && viewerLocation) {
      const tLoc = t.location.toLowerCase();
      const vLoc = viewerLocation.toLowerCase();
      if (!vLoc.includes(tLoc) && !tLoc.includes(vLoc)) return false;
    }

    // Interest match — at least one overlap
    if (t.interests && t.interests.length > 0 && viewerInterests.length > 0) {
      const hasOverlap = t.interests.some((i) => viewerInterests.includes(i));
      if (!hasOverlap) return false;
    }

    return true;
  });

  // Fall back to unfiltered if targeting is too restrictive
  const result = filtered.length >= 1 ? filtered : candidates;
  return result.slice(0, 3);
};
