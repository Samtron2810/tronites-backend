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
    const callbackBase = process.env.PAYSTACK_CALLBACK_URL;
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