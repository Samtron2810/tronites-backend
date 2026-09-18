import express from "express";
import protect from "../middleware/authMiddleware.js";
import requireModerator from "../middleware/requireModerator.js";
import requirePermission from "../middleware/requirePermission.js";
import { validate } from "../utils/validators.js";
import {
  promotePostSchema,
  adminPromotePostSchema,
  adminExtendPromotionSchema,
} from "../utils/validators.js";
import {
  getPromotionFees,
  initiatePromotion,
  verifyPromotion,
  cancelPromotion,
  getMyPromotions,
  recordImpression,
  recordClick,
  recordCtaClick,
  adminPromotePost,
  adminCancelPromotion,
  adminExtendPromotion,
  adminListPromotions,
} from "../controllers/promotedPostController.js";

// Paid post promotion (business tier). Mounted by index.js at
// /api/posts/promote BEFORE postRoutes so the literal /fees, /initiate,
// /verify/:reference, /cancel/:postId and /admin/:postId segments never
// fall through to a post :id.
const router = express.Router();

router.get("/fees", protect, getPromotionFees);
// Moderator/admin promotions-management list — literal /admin/all, must sit
// above /admin/:postId (POST) is fine since methods differ, but keep it
// grouped with the other /admin/* routes below for readability.
router.get(
  "/admin/all",
  protect,
  requireModerator,
  requirePermission("manage_content"),
  adminListPromotions,
);
router.get("/my-promotions", protect, getMyPromotions);
router.post("/initiate", protect, validate(promotePostSchema), initiatePromotion);
router.get("/verify/:reference", protect, verifyPromotion);
// Clears a stuck promotionReference after a failed/abandoned payment so the
// user can retry. Owner-only; rejected if the post is already promoted.
router.delete("/cancel/:postId", protect, cancelPromotion);
router.post("/impression/:postId", protect, recordImpression);
router.post("/click/:postId", protect, recordClick);
router.post("/cta-click/:postId", protect, recordCtaClick);
// Moderator/admin comp — free promotion for an eligible creator's or
// business's post, gated the same way as other content-moderation
// actions (requireModerator shape guard, then manage_content decides —
// admins pass implicitly, moderators need the permission granted).
router.post(
  "/admin/:postId",
  protect,
  requireModerator,
  requirePermission("manage_content"),
  validate(adminPromotePostSchema),
  adminPromotePost,
);
// Force-cancel any promotion (active or pending), regardless of owner —
// the moderation team's "pull the ad" lever. Same permission gate as the
// comp grant above.
router.delete(
  "/admin/cancel/:postId",
  protect,
  requireModerator,
  requirePermission("manage_content"),
  adminCancelPromotion,
);
// Extend an already-active promotion by N days.
router.put(
  "/admin/extend/:postId",
  protect,
  requireModerator,
  requirePermission("manage_content"),
  validate(adminExtendPromotionSchema),
  adminExtendPromotion,
);

export default router;
