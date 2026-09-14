import express from "express";
import protect from "../middleware/authMiddleware.js";
import requireCreator from "../middleware/requireCreator.js";
import {
  // Tips
  initiateTip,
  verifyTip,
  getReceivedTips,
  // Plans & Subscriptions
  getCreatorPlan,
  upsertCreatorPlan,
  initiateSubscription,
  verifySubscription,
  cancelSubscription,
  getSubscriptionStatus,
  getSubscribers,
  // Subscriber post access check
  checkSubscriberAccess,
  // Earnings & Payouts
  getEarnings,
  upsertBankAccount,
  getBankAccount,
  requestPayout,
  getPayoutHistory,
  // Media Kit
  getMediaKit,
} from "../controllers/creatorMonetizationController.js";

const router = express.Router();

// ── Public (no auth required) ───────────────────────────────────────────────
// Media kit — visible to brands, viewers, anyone
router.get("/media-kit/:creatorId", getMediaKit);
// Creator's subscription plan — visible on their profile
router.get("/plan/:creatorId", getCreatorPlan);

// ── Authenticated ───────────────────────────────────────────────────────────
router.use(protect);

// Tips
router.post("/tips/initiate", initiateTip);
router.get("/tips/verify/:reference", verifyTip);
// Subscription initiation & verification (subscriber-side)
router.post("/subscribe/initiate", initiateSubscription);
router.get("/subscribe/verify/:reference", verifySubscription);
router.delete("/subscribe/:creatorId", cancelSubscription);
router.get("/subscribe/status/:creatorId", getSubscriptionStatus);
// Subscriber access check for locked posts
router.get("/can-view/:postId", checkSubscriberAccess);

// ── Creator-only routes ─────────────────────────────────────────────────────
router.use(requireCreator);

// Tips received by this creator
router.get("/tips/received", getReceivedTips);
// Plan management
router.post("/plan", upsertCreatorPlan);
// Subscriber list
router.get("/subscribers", getSubscribers);
// Earnings dashboard
router.get("/earnings", getEarnings);
// Bank account
router.get("/bank-account", getBankAccount);
router.post("/bank-account", upsertBankAccount);
// Payouts
router.post("/payout/request", requestPayout);
router.get("/payout/history", getPayoutHistory);

export default router;
