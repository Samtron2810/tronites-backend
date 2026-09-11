import crypto from "crypto";
import Post from "../models/Post.js";
import User from "../models/User.js";
import { canPromote } from "../utils/tierLimits.js";
import {
  initializeTransaction,
  verifyTransaction,
} from "../services/paystackService.js";
import { invalidateCache, invalidateFeedCache } from "../utils/redis.js";

// Paid post promotion (business tier only). Price/size are env-tunable:
//   PROMOTE_POST_PRICE_NGN — whole naira (converted to kobo ×100). Default 2000.
//   PROMOTE_POST_DAYS      — how long a promotion lasts. Default 7.
const PROMOTE_POST_PRICE_NGN = Number(process.env.PROMOTE_POST_PRICE_NGN) || 2000;
const PROMOTE_POST_DAYS = Number(process.env.PROMOTE_POST_DAYS) || 7;

const PROMO_REFERENCE_PREFIX = "tronites_promo_";

// GET /posts/promote/fees — lets the frontend show the price before paying.
export const getPromotionFees = async (_req, res) => {
  try {
    res.status(200).json({
      amountNgn: PROMOTE_POST_PRICE_NGN,
      promoDays: PROMOTE_POST_DAYS,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// POST /posts/promote/initiate { postId }
// Business-tier only. Creates a Paystack transaction tied to this post and
// returns the checkout URL; the charge is not applied until the browser
// returns from Paystack and the frontend calls /verify/:reference.
export const initiatePromotion = async (req, res) => {
  try {
    if (!canPromote(req.user)) {
      return res.status(403).json({
        message: "Promoted posts are available to verified business accounts only.",
        code: "PROMOTING_UNAVAILABLE",
      });
    }

    const { postId } = req.body;
    const post = await Post.findById(postId).select(
      "user removedAt promotedUntil promotionReference",
    );
    if (!post || post.removedAt) {
      return res.status(404).json({ message: "Post not found." });
    }
    if (post.user.toString() !== req.user._id.toString()) {
      return res
        .status(403)
        .json({ message: "You can only promote your own posts." });
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
    if (!owner) {
      return res.status(404).json({ message: "User not found." });
    }

    const reference = `${PROMO_REFERENCE_PREFIX}${crypto.randomBytes(12).toString("hex")}`;

    // PAYSTACK_PROMO_CALLBACK_URL is the dedicated env var for post-promotion
    // payments — lands on /paystack-return which runs verifyPromotion.
    // Falls back to PAYSTACK_CALLBACK_URL for backwards compat, then undefined
    // (Paystack uses its dashboard default).
    const callbackBase =
      process.env.PAYSTACK_PROMO_CALLBACK_URL ||
      process.env.PAYSTACK_CALLBACK_URL;
    const callbackUrl = callbackBase
      ? `${callbackBase.replace(/\/$/, "")}?paystack_ref=${reference}`
      : undefined;

    const paystackData = await initializeTransaction({
      email: owner.email,
      amountKobo: PROMOTE_POST_PRICE_NGN * 100,
      reference,
      metadata: {
        userId: req.user._id.toString(),
        postId: post._id.toString(),
        platform: "tronites",
      },
      callbackUrl,
    });

    // Stamp the reference BEFORE the user can complete payment so a second
    // initiate can't create a duplicate charge for the same post.
    await post.updateOne({ $set: { promotionReference: reference } });

    res.status(200).json({
      reference,
      authorizationUrl: paystackData.authorization_url,
      amountNgn: PROMOTE_POST_PRICE_NGN,
      promoDays: PROMOTE_POST_DAYS,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// GET /posts/promote/verify/:reference
// Frontend calls this after the Paystack redirect returns. On success the
// post becomes promoted until now + PROMOTE_POST_DAYS.
export const verifyPromotion = async (req, res) => {
  try {
    const { reference } = req.params;
    const post = await Post.findOne({
      user: req.user._id,
      promotionReference: reference,
    });
    if (!post) {
      return res
        .status(404)
        .json({ message: "Promotion payment not found." });
    }

    const data = await verifyTransaction(reference);
    if (data.status !== "success") {
      return res.status(402).json({
        message: `Payment not successful (status: ${data.status}). Please try again.`,
      });
    }

    const promotedUntil = new Date(
      Date.now() + PROMOTE_POST_DAYS * 24 * 60 * 60 * 1000,
    );
    await post.updateOne({
      $set: { promotedUntil, promotionReference: null },
    });

    invalidateFeedCache(req.user._id);
    invalidateCache(`profile-posts:${req.user._id}:*`);

    res.status(200).json({ verified: true, promotedUntil });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

// DELETE /posts/promote/cancel/:postId
// Clears a stuck promotionReference so the user can retry payment after a
// failed/abandoned Paystack session. Only the post owner can cancel, and only
// when the post isn't already successfully promoted (promotedUntil still in
// the future means the charge went through — no cancel needed there).
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
      return res
        .status(403)
        .json({ message: "You can only cancel your own post's promotion." });
    }
    // Don't let them cancel a promotion that already succeeded.
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

// GET /posts/promote/my-promotions — paginated list of the authenticated
// user's posts that have been promoted or are pending promotion.
// Returns: { promotions: [...], total: Number }
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
        { promotedUntil: { $ne: null } },  // was / is promoted
        { promotionReference: { $ne: null } }, // payment pending
      ],
    };

    const [posts, total] = await Promise.all([
      Post.find(filter)
        .select("text images video createdAt promotedUntil promotionReference likesCount commentsCount repostsCount")
        .sort({ updatedAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Post.countDocuments(filter),
    ]);

    const promotions = posts.map((p) => {
      let status;
      if (p.promotionReference && (!p.promotedUntil || new Date(p.promotedUntil) <= now)) {
        status = "pending";  // payment initiated but not verified yet
      } else if (p.promotedUntil && new Date(p.promotedUntil) > now) {
        status = "active";   // currently in feed
      } else {
        status = "expired";  // promotion period ended
      }
      return {
        _id: p._id,
        text: p.text,
        images: p.images,
        video: p.video,
        createdAt: p.createdAt,
        promotedUntil: p.promotedUntil,
        promotionReference: p.promotionReference,
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

// GET /posts/promote/promoted — returns currently-promoted posts for feed
// injection. Used internally by getFeedPosts / getForYouFeed; also exported
// so the route can expose it as a standalone endpoint if needed later.
// Limit is capped at 3 so the feed never becomes ad-heavy; posts are ordered
// by promotedUntil desc so the most recently promoted surfaces first.
export const getPromotedPostsForFeed = async (excludeIds = []) => {
  const now = new Date();
  return Post.find({
    promotedUntil: { $gt: now },
    removedAt: null,
    ...(excludeIds.length ? { _id: { $nin: excludeIds } } : {}),
  })
    .populate("user", "name username profilePic verifications isVerified")
    .sort({ promotedUntil: -1 })
    .limit(3)
    .lean();
};
