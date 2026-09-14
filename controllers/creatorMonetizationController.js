import crypto from "crypto";
import User from "../models/User.js";
import Post from "../models/Post.js";
import CreatorTip from "../models/CreatorTip.js";
import {
  CreatorPlan,
  CreatorSubscription,
} from "../models/CreatorSubscription.js";
import { CreatorBankAccount, CreatorPayout } from "../models/CreatorPayout.js";
import Notification from "../models/Notification.js";
import Follow from "../models/Follow.js";
import Like from "../models/Like.js";
import Comment from "../models/Comment.js";
import Repost from "../models/Repost.js";
import Bookmark from "../models/Bookmark.js";
import {
  initializeTransaction,
  verifyTransaction,
} from "../services/paystackService.js";
import { emitToUser } from "../socket/socket.js";
import { invalidateCache, getOrSetCache } from "../utils/redis.js";

// ─── ENV ────────────────────────────────────────────────────────────────────
// Platform fee taken from each tip/subscription (10% default).
const PLATFORM_FEE_PCT = Number(process.env.CREATOR_PLATFORM_FEE_PCT) || 10;

// Minimum payout amount in NGN.
const MIN_PAYOUT_NGN = Number(process.env.CREATOR_MIN_PAYOUT_NGN) || 500;

const TIP_REFERENCE_PREFIX = "tronites_tip_";
const SUB_REFERENCE_PREFIX = "tronites_sub_";

// ─── Helpers ────────────────────────────────────────────────────────────────

const hasActiveCreatorBadge = (user) => {
  if (!Array.isArray(user?.verifications)) return false;
  const now = new Date();
  return user.verifications.some(
    (v) =>
      v.type === "creator" && (!v.expiresAt || new Date(v.expiresAt) > now),
  );
};

// Checks if viewer has an active subscription to creatorId.
const isActiveSubscriber = async (viewerId, creatorId) => {
  if (!viewerId) return false;
  const sub = await CreatorSubscription.findOne({
    subscriber: viewerId,
    creator: creatorId,
    status: "active",
    currentPeriodEnd: { $gt: new Date() },
  }).lean();
  return !!sub;
};

// Compute earned balance for a creator (verified tips + active sub revenue).
// Returns kobo amounts.
const computeEarnings = async (creatorId) => {
  const [tipsAgg, subsAgg, pendingPayout, paidPayout] = await Promise.all([
    // Total verified tips received
    CreatorTip.aggregate([
      { $match: { creator: creatorId, status: "verified" } },
      { $group: { _id: null, total: { $sum: "$amountKobo" } } },
    ]),
    // Total subscription revenue (count * plan price — simplified: use stored amountKobo from tip model analogue)
    // For subscriptions we track charges through CreatorTip with type hint; simpler: count via subscription model
    // We'll use a separate tips-equivalent approach (subscription charges are tracked in CreatorTip with post=null)
    CreatorTip.aggregate([
      { $match: { creator: creatorId, status: "verified" } },
      {
        $group: {
          _id: null,
          total: { $sum: "$amountKobo" },
          count: { $sum: 1 },
        },
      },
    ]),
    // Pending / processing payouts
    CreatorPayout.aggregate([
      {
        $match: {
          creator: creatorId,
          status: { $in: ["pending", "processing"] },
        },
      },
      { $group: { _id: null, total: { $sum: "$amountKobo" } } },
    ]),
    // Already paid out
    CreatorPayout.aggregate([
      { $match: { creator: creatorId, status: "paid" } },
      { $group: { _id: null, total: { $sum: "$amountKobo" } } },
    ]),
  ]);

  const totalEarnedKobo = tipsAgg[0]?.total ?? 0;
  const platformFeeKobo = Math.round(
    totalEarnedKobo * (PLATFORM_FEE_PCT / 100),
  );
  const netEarnedKobo = totalEarnedKobo - platformFeeKobo;
  const pendingPayoutKobo = pendingPayout[0]?.total ?? 0;
  const paidPayoutKobo = paidPayout[0]?.total ?? 0;
  const availableKobo = Math.max(
    0,
    netEarnedKobo - pendingPayoutKobo - paidPayoutKobo,
  );

  return {
    totalEarnedKobo,
    platformFeeKobo,
    netEarnedKobo,
    pendingPayoutKobo,
    paidPayoutKobo,
    availableKobo,
    platformFeePct: PLATFORM_FEE_PCT,
  };
};

// ─── TIPPING ────────────────────────────────────────────────────────────────

// POST /creator-monetization/tips/initiate
// Any authenticated user can tip a creator. Returns Paystack checkout URL.
export const initiateTip = async (req, res) => {
  try {
    const { creatorId, amountNgn, message, isAnonymous, postId } = req.body;

    if (!creatorId)
      return res.status(400).json({ message: "creatorId required." });
    if (!amountNgn || amountNgn < 50)
      return res.status(400).json({ message: "Minimum tip is ₦50." });
    if (amountNgn > 100_000)
      return res
        .status(400)
        .json({ message: "Maximum single tip is ₦100,000." });

    const creator = await User.findById(creatorId).select(
      "email name username verifications deletedAt",
    );
    if (!creator || creator.deletedAt)
      return res.status(404).json({ message: "Creator not found." });
    if (!hasActiveCreatorBadge(creator))
      return res.status(403).json({ message: "This user is not a creator." });
    if (creator._id.toString() === req.user._id.toString())
      return res.status(400).json({ message: "You cannot tip yourself." });

    // Validate postId if provided
    if (postId) {
      const post = await Post.findById(postId).select("user removedAt");
      if (!post || post.removedAt || post.user.toString() !== creatorId)
        return res.status(404).json({ message: "Post not found." });
    }

    const reference = `${TIP_REFERENCE_PREFIX}${crypto.randomBytes(12).toString("hex")}`;
    const amountKobo = amountNgn * 100;

    const callbackBase =
      process.env.PAYSTACK_TIP_CALLBACK_URL ||
      process.env.PAYSTACK_CALLBACK_URL;
    const callbackUrl = callbackBase
      ? `${callbackBase.replace(/\/$/, "")}?paystack_ref=${reference}&flow=tip`
      : undefined;

    const paystackData = await initializeTransaction({
      email: req.user.email,
      amountKobo,
      reference,
      metadata: {
        flow: "tip",
        senderId: req.user._id.toString(),
        creatorId,
        postId: postId || null,
        message: message?.trim()?.slice(0, 150) || "",
        isAnonymous: !!isAnonymous,
        platform: "tronites",
      },
      callbackUrl,
    });

    // Create tip record in initiated state — verified on return.
    await CreatorTip.create({
      sender: req.user._id,
      creator: creatorId,
      post: postId || null,
      amountKobo,
      reference,
      status: "initiated",
      message: message?.trim()?.slice(0, 150) || "",
      isAnonymous: !!isAnonymous,
    });

    res.status(200).json({
      reference,
      authorizationUrl: paystackData.authorization_url,
      amountNgn,
      creatorName: creator.name,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// GET /creator-monetization/tips/verify/:reference
// Called by frontend after Paystack redirect. Marks tip verified and fires notification.
export const verifyTip = async (req, res) => {
  try {
    const { reference } = req.params;
    const tip = await CreatorTip.findOne({ reference });
    if (!tip) return res.status(404).json({ message: "Tip not found." });
    if (tip.status === "verified")
      return res.status(200).json({ verified: true });
    if (tip.sender.toString() !== req.user._id.toString())
      return res.status(403).json({ message: "Not your transaction." });

    const data = await verifyTransaction(reference);
    if (data.status !== "success") {
      await tip.updateOne({ $set: { status: "failed" } });
      return res.status(402).json({
        message: `Payment not successful (status: ${data.status}).`,
      });
    }

    await tip.updateOne({ $set: { status: "verified" } });

    // Invalidate creator earnings cache
    invalidateCache(`creator-earnings:${tip.creator}`);

    // Notify the creator
    const notification = await Notification.create({
      recipient: tip.creator,
      sender: tip.isAnonymous ? null : req.user._id,
      type: "creator_tip",
      post: tip.post || null,
      message: tip.isAnonymous
        ? `Someone sent you a ₦${(tip.amountKobo / 100).toLocaleString()} tip${tip.message ? `: "${tip.message}"` : "!"}`
        : `${req.user.name} sent you a ₦${(tip.amountKobo / 100).toLocaleString()} tip${tip.message ? `: "${tip.message}"` : "!"}`,
    });
    emitToUser(tip.creator.toString(), "newNotification", notification);

    res.status(200).json({ verified: true, amountNgn: tip.amountKobo / 100 });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// GET /creator-monetization/tips/received — creator's received tips (paginated)
export const getReceivedTips = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(20, parseInt(req.query.limit) || 15);
    const skip = (page - 1) * limit;

    const [tips, total] = await Promise.all([
      CreatorTip.find({ creator: req.user._id, status: "verified" })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("sender", "name username profilePic")
        .populate("post", "text")
        .lean(),
      CreatorTip.countDocuments({ creator: req.user._id, status: "verified" }),
    ]);

    const sanitized = tips.map((t) => ({
      ...t,
      sender: t.isAnonymous ? null : t.sender,
    }));

    res.status(200).json({ tips: sanitized, total, page, limit });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ─── SUBSCRIPTION PLAN ──────────────────────────────────────────────────────

// GET /creator-monetization/plan/:creatorId — public, returns a creator's plan
export const getCreatorPlan = async (req, res) => {
  try {
    const creatorId =
      req.params.creatorId === "me" ? req.user?._id : req.params.creatorId;
    if (!creatorId)
      return res.status(400).json({ message: "creatorId required." });

    const plan = await CreatorPlan.findOne({
      creator: creatorId,
      active: true,
    }).lean();

    // For "me" requests from unauthenticated — shouldn't reach here but safe guard
    if (req.params.creatorId !== "me" && !plan)
      return res.status(404).json({ message: "No active plan." });

    const subCount = plan
      ? await CreatorSubscription.countDocuments({
          creator: creatorId,
          status: "active",
          currentPeriodEnd: { $gt: new Date() },
        })
      : 0;

    res.status(200).json({ plan: plan || null, subscriberCount: subCount });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// POST /creator-monetization/plan — creator creates/updates their subscription plan
export const upsertCreatorPlan = async (req, res) => {
  try {
    const { name, perks, priceNgn, active } = req.body;
    if (!name?.trim())
      return res.status(400).json({ message: "Plan name required." });
    if (!priceNgn || priceNgn < 100)
      return res
        .status(400)
        .json({ message: "Minimum plan price is ₦100/month." });
    if (priceNgn > 50_000)
      return res
        .status(400)
        .json({ message: "Maximum plan price is ₦50,000/month." });

    const plan = await CreatorPlan.findOneAndUpdate(
      { creator: req.user._id },
      {
        $set: {
          name: name.trim().slice(0, 60),
          perks: perks?.trim()?.slice(0, 300) || "",
          priceNgn,
          ...(active !== undefined ? { active } : {}),
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );

    invalidateCache(`creator-plan:${req.user._id}`);
    invalidateCache(`mediakit:${req.user._id}`);
    res.status(200).json({ plan });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// POST /creator-monetization/subscribe/initiate
// Any authenticated user initiates a monthly subscription to a creator.
export const initiateSubscription = async (req, res) => {
  try {
    const { creatorId } = req.body;
    if (!creatorId)
      return res.status(400).json({ message: "creatorId required." });
    if (creatorId === req.user._id.toString())
      return res
        .status(400)
        .json({ message: "You cannot subscribe to yourself." });

    const [creator, plan] = await Promise.all([
      User.findById(creatorId).select(
        "name username verifications deletedAt email",
      ),
      CreatorPlan.findOne({ creator: creatorId, active: true }).lean(),
    ]);

    if (!creator || creator.deletedAt)
      return res.status(404).json({ message: "Creator not found." });
    if (!hasActiveCreatorBadge(creator))
      return res.status(403).json({ message: "This user is not a creator." });
    if (!plan)
      return res
        .status(404)
        .json({ message: "Creator has no active subscription plan." });

    // Check for existing active subscription
    const existing = await CreatorSubscription.findOne({
      subscriber: req.user._id,
      creator: creatorId,
    });
    if (existing?.status === "active" && existing.currentPeriodEnd > new Date())
      return res
        .status(409)
        .json({ message: "You already have an active subscription." });

    const reference = `${SUB_REFERENCE_PREFIX}${crypto.randomBytes(12).toString("hex")}`;
    const amountKobo = plan.priceNgn * 100;

    const callbackBase =
      process.env.PAYSTACK_SUB_CALLBACK_URL ||
      process.env.PAYSTACK_CALLBACK_URL;
    const callbackUrl = callbackBase
      ? `${callbackBase.replace(/\/$/, "")}?paystack_ref=${reference}&flow=subscription`
      : undefined;

    const paystackData = await initializeTransaction({
      email: req.user.email,
      amountKobo,
      reference,
      metadata: {
        flow: "subscription",
        subscriberId: req.user._id.toString(),
        creatorId,
        planId: plan._id.toString(),
        platform: "tronites",
      },
      callbackUrl,
    });

    res.status(200).json({
      reference,
      authorizationUrl: paystackData.authorization_url,
      amountNgn: plan.priceNgn,
      planName: plan.name,
      creatorName: creator.name,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// GET /creator-monetization/subscribe/verify/:reference
// Called by frontend after Paystack redirect. Creates/renews subscription.
export const verifySubscription = async (req, res) => {
  try {
    const { reference } = req.params;

    const data = await verifyTransaction(reference);
    if (data.status !== "success") {
      return res.status(402).json({
        message: `Payment not successful (status: ${data.status}).`,
      });
    }

    const meta = data.metadata || {};
    const { subscriberId, creatorId, planId } = meta;
    if (!subscriberId || !creatorId || !planId)
      return res.status(400).json({ message: "Invalid transaction metadata." });

    if (subscriberId !== req.user._id.toString())
      return res.status(403).json({ message: "Not your transaction." });

    const plan = await CreatorPlan.findById(planId).lean();
    if (!plan) return res.status(404).json({ message: "Plan not found." });

    // currentPeriodEnd = now + 30 days
    const currentPeriodEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    const authorization = data.authorization || {};

    const sub = await CreatorSubscription.findOneAndUpdate(
      { subscriber: req.user._id, creator: creatorId },
      {
        $set: {
          plan: planId,
          status: "active",
          currentPeriodEnd,
          paystackAuthCode: authorization.authorization_code || null,
          paystackCustomerCode: data.customer?.customer_code || null,
          subscriberEmail: req.user.email,
          lastChargeReference: reference,
          lastChargedAt: new Date(),
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );

    // Record the subscription charge in the tip ledger so earnings reflect it
    await CreatorTip.findOneAndUpdate(
      { reference },
      {
        $setOnInsert: {
          sender: req.user._id,
          creator: creatorId,
          post: null,
          amountKobo: plan.priceNgn * 100,
          reference,
          status: "verified",
          message: "Monthly subscription",
          isAnonymous: false,
        },
      },
      { upsert: true, new: true },
    );

    invalidateCache(`creator-earnings:${creatorId}`);
    invalidateCache(`sub-status:${req.user._id}:${creatorId}`);
    invalidateCache(`mediakit:${creatorId}`);

    // Notify creator
    const notification = await Notification.create({
      recipient: creatorId,
      sender: req.user._id,
      type: "creator_subscribe",
      message: `${req.user.name} subscribed to your channel.`,
    });
    emitToUser(creatorId, "newNotification", notification);

    res.status(200).json({
      verified: true,
      subscriptionId: sub._id,
      currentPeriodEnd,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// DELETE /creator-monetization/subscribe/:creatorId — cancel subscription
export const cancelSubscription = async (req, res) => {
  try {
    const { creatorId } = req.params;
    const sub = await CreatorSubscription.findOne({
      subscriber: req.user._id,
      creator: creatorId,
    });
    if (!sub)
      return res.status(404).json({ message: "Subscription not found." });
    if (sub.status !== "active")
      return res
        .status(409)
        .json({ message: "Subscription is already cancelled." });

    await sub.updateOne({ $set: { status: "cancelled" } });
    invalidateCache(`sub-status:${req.user._id}:${creatorId}`);
    invalidateCache(`mediakit:${creatorId}`);

    res.status(200).json({
      cancelled: true,
      accessUntil: sub.currentPeriodEnd,
      message: `Access continues until ${new Date(sub.currentPeriodEnd).toLocaleDateString()}.`,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// GET /creator-monetization/subscribe/status/:creatorId
// Returns whether current user is subscribed to a creator.
export const getSubscriptionStatus = async (req, res) => {
  try {
    const { creatorId } = req.params;
    const sub = await CreatorSubscription.findOne({
      subscriber: req.user._id,
      creator: creatorId,
    })
      .populate("plan", "name priceNgn")
      .lean();

    if (!sub) return res.status(200).json({ subscribed: false });

    const isActive =
      sub.status === "active" && new Date(sub.currentPeriodEnd) > new Date();

    res.status(200).json({
      subscribed: isActive,
      status: sub.status,
      currentPeriodEnd: sub.currentPeriodEnd,
      plan: sub.plan,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// GET /creator-monetization/subscribers — creator's subscriber list (paginated)
export const getSubscribers = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(30, parseInt(req.query.limit) || 20);
    const skip = (page - 1) * limit;

    const now = new Date();
    const [subs, total] = await Promise.all([
      CreatorSubscription.find({
        creator: req.user._id,
        status: "active",
        currentPeriodEnd: { $gt: now },
      })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("subscriber", "name username profilePic")
        .lean(),
      CreatorSubscription.countDocuments({
        creator: req.user._id,
        status: "active",
        currentPeriodEnd: { $gt: now },
      }),
    ]);

    res.status(200).json({ subscribers: subs, total, page, limit });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ─── SUBSCRIBER-ONLY POSTS ──────────────────────────────────────────────────

// GET /creator-monetization/can-view-subscriber-post/:postId
// Checks whether the requesting user can view a subscriber-only post.
// POST endpoint (postController) enforces this at read time too — this
// is for the frontend to gate the unlock CTA before a full request.
export const checkSubscriberAccess = async (req, res) => {
  try {
    const { postId } = req.params;
    const post = await Post.findById(postId)
      .select("user privacy removedAt")
      .lean();
    if (!post || post.removedAt)
      return res.status(404).json({ message: "Post not found." });

    // Author always has access
    if (post.user.toString() === req.user._id.toString())
      return res.status(200).json({ access: true, reason: "owner" });

    if (post.privacy !== "subscribers")
      return res.status(200).json({ access: true, reason: "public" });

    const active = await isActiveSubscriber(req.user._id, post.user);
    res.status(200).json({
      access: active,
      reason: active ? "subscriber" : "not_subscribed",
      creatorId: post.user,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ─── EARNINGS & PAYOUTS ─────────────────────────────────────────────────────

// GET /creator-monetization/earnings — creator's earnings summary
export const getEarnings = async (req, res) => {
  try {
    const creatorId = req.user._id;

    const [earnings, recentTips, recentPayouts, subCount] = await Promise.all([
      computeEarnings(creatorId),
      CreatorTip.find({ creator: creatorId, status: "verified" })
        .sort({ createdAt: -1 })
        .limit(10)
        .populate("sender", "name username profilePic")
        .populate("post", "text")
        .lean(),
      CreatorPayout.find({ creator: creatorId })
        .sort({ createdAt: -1 })
        .limit(10)
        .lean(),
      CreatorSubscription.countDocuments({
        creator: creatorId,
        status: "active",
        currentPeriodEnd: { $gt: new Date() },
      }),
    ]);

    const tips = recentTips.map((t) => ({
      ...t,
      sender: t.isAnonymous ? null : t.sender,
    }));

    res.status(200).json({
      earnings,
      minPayoutNgn: MIN_PAYOUT_NGN,
      recentTips: tips,
      recentPayouts,
      activeSubscriberCount: subCount,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// POST /creator-monetization/bank-account — save/update bank details
// NOTE: In production this would call Paystack's /transferrecipient API to
// create a recipient code. Stub here stores the details; the transfer
// initiation step below uses them.
export const upsertBankAccount = async (req, res) => {
  try {
    const { bankName, accountName, accountNumber, bankCode } = req.body;
    if (!bankName || !accountName || !accountNumber || !bankCode)
      return res.status(400).json({ message: "All bank fields are required." });
    if (!/^\d{10}$/.test(accountNumber))
      return res
        .status(400)
        .json({ message: "Account number must be 10 digits." });

    const bankAccount = await CreatorBankAccount.findOneAndUpdate(
      { creator: req.user._id },
      {
        $set: {
          bankName: bankName.trim().slice(0, 100),
          accountName: accountName.trim().slice(0, 120),
          accountNumberLast4: accountNumber.slice(-4),
          bankCode: bankCode.trim().slice(0, 10),
          // paystackRecipientCode would be set after calling Paystack API
          paystackRecipientCode: null,
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );

    res.status(200).json({ bankAccount });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// GET /creator-monetization/bank-account
export const getBankAccount = async (req, res) => {
  try {
    const bankAccount = await CreatorBankAccount.findOne({
      creator: req.user._id,
    }).lean();
    res.status(200).json({ bankAccount: bankAccount || null });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// POST /creator-monetization/payout/request — creator requests a withdrawal
export const requestPayout = async (req, res) => {
  try {
    const { amountNgn } = req.body;
    if (!amountNgn || amountNgn < MIN_PAYOUT_NGN)
      return res
        .status(400)
        .json({ message: `Minimum withdrawal is ₦${MIN_PAYOUT_NGN}.` });

    const bankAccount = await CreatorBankAccount.findOne({
      creator: req.user._id,
    });
    if (!bankAccount)
      return res
        .status(400)
        .json({ message: "Add your bank account before requesting a payout." });

    const earnings = await computeEarnings(req.user._id);
    const requestedKobo = amountNgn * 100;

    if (requestedKobo > earnings.availableKobo)
      return res.status(400).json({
        message: `Insufficient balance. Available: ₦${(earnings.availableKobo / 100).toLocaleString()}.`,
      });

    // Check no pending payout already exists
    const existingPending = await CreatorPayout.findOne({
      creator: req.user._id,
      status: { $in: ["pending", "processing"] },
    });
    if (existingPending)
      return res.status(409).json({
        message: "You already have a pending payout request.",
      });

    const payout = await CreatorPayout.create({
      creator: req.user._id,
      amountKobo: requestedKobo,
      status: "pending",
    });

    invalidateCache(`creator-earnings:${req.user._id}`);
    res.status(201).json({ payout });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// GET /creator-monetization/payout/history
export const getPayoutHistory = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(20, parseInt(req.query.limit) || 15);
    const skip = (page - 1) * limit;

    const [payouts, total] = await Promise.all([
      CreatorPayout.find({ creator: req.user._id })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      CreatorPayout.countDocuments({ creator: req.user._id }),
    ]);

    res.status(200).json({ payouts, total, page, limit });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ─── MEDIA KIT ──────────────────────────────────────────────────────────────

// GET /creator-monetization/media-kit/:creatorId
// Public endpoint — brands/viewers can fetch a creator's auto-generated media kit.
export const getMediaKit = async (req, res) => {
  try {
    const { creatorId } = req.params;

    // Fetch from cache or compute if not cached (60-second TTL)
    const mediaKitData = await getOrSetCache(
      `mediakit:${creatorId}`,
      async () => {
        const [creator, postStats, plan, subCount] = await Promise.all([
          User.findById(creatorId)
            .select(
              "name username bio profilePic verifications isVerified followersCount openToCollabs interests location createdAt",
            )
            .lean(),
          Post.aggregate([
            {
              $match: {
                user: new (await import("mongoose")).default.Types.ObjectId(
                  creatorId,
                ),
                removedAt: null,
                scheduledFor: null,
                // Count all published posts regardless of privacy setting so
                // the post count on the media kit always reflects reality.
              },
            },
            {
              $group: {
                _id: null,
                postCount: { $sum: 1 },
                totalLikes: { $sum: "$likesCount" },
                totalComments: { $sum: "$commentsCount" },
                totalReposts: { $sum: "$repostsCount" },
                avgLikes: { $avg: "$likesCount" },
                avgComments: { $avg: "$commentsCount" },
              },
            },
          ]),
          CreatorPlan.findOne({ creator: creatorId, active: true }).lean(),
          CreatorSubscription.countDocuments({
            creator: creatorId,
            status: "active",
            currentPeriodEnd: { $gt: new Date() },
          }),
        ]);

        if (!creator) return null;

        // Media kit is available to creator-badged AND business-badged accounts.
        // A business account without a creator badge should still be able to
        // share a media kit with potential collaborators.
        const hasEligibleBadge =
          hasActiveCreatorBadge({ verifications: creator.verifications }) ||
          (Array.isArray(creator.verifications) &&
            creator.verifications.some(
              (v) =>
                v.type === "business" &&
                (!v.expiresAt || new Date(v.expiresAt) > new Date()),
            ));

        if (!hasEligibleBadge) return null;

        const stats = postStats[0] || {
          postCount: 0,
          totalLikes: 0,
          totalComments: 0,
          totalReposts: 0,
          avgLikes: 0,
          avgComments: 0,
        };

        // Engagement rate: (avg likes + avg comments) / followers * 100
        const engagementRate =
          creator.followersCount > 0
            ? (((stats.avgLikes || 0) + (stats.avgComments || 0)) /
                creator.followersCount) *
              100
            : 0;

        // Top posts in last 30 days for the kit
        const topPosts = await Post.find({
          user: creatorId,
          removedAt: null,
          scheduledFor: null,
          privacy: "public",
          createdAt: { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
        })
          .sort({ likesCount: -1 })
          .limit(3)
          .select("text images likesCount commentsCount repostsCount createdAt")
          .lean();

        return {
          creator: {
            name: creator.name,
            username: creator.username,
            bio: creator.bio,
            profilePic: creator.profilePic,
            location: creator.location,
            interests: creator.interests,
            memberSince: creator.createdAt,
            openToCollabs: creator.openToCollabs,
            isVerified: creator.isVerified,
          },
          reach: {
            followers: creator.followersCount,
            totalPosts: stats.postCount,
            totalLikes: stats.totalLikes,
            totalComments: stats.totalComments,
            totalReposts: stats.totalReposts,
            activeSubscribers: subCount,
          },
          engagement: {
            avgLikesPerPost: Math.round(stats.avgLikes || 0),
            avgCommentsPerPost: Math.round(stats.avgComments || 0),
            engagementRatePct: Math.round(engagementRate * 10) / 10,
          },
          subscriptionPlan: plan
            ? { name: plan.name, priceNgn: plan.priceNgn, perks: plan.perks }
            : null,
          topPosts,
          generatedAt: new Date(),
        };
      },
      60000, // 60-second TTL
    );

    if (!mediaKitData)
      return res.status(404).json({ message: "Creator not found." });

    res.status(200).json({
      mediaKit: mediaKitData,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
