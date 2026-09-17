import express from "express";
import protect from "../middleware/authMiddleware.js";
import requireModerator from "../middleware/requireModerator.js";
import requirePermission from "../middleware/requirePermission.js";
import { validate } from "../utils/validators.js";
import { promotePostSchema, adminPromotePostSchema } from "../utils/validators.js";
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
} from "../controllers/promotedPostController.js";

// Paid post promotion (business tier). Mounted by index.js at
// /api/posts/promote BEFORE postRoutes so the literal /fees, /initiate,
// /verify/:reference, /cancel/:postId and /admin/:postId segments never
// fall through to a post :id.
const router = express.Router();

router.get("/fees", protect, getPromotionFees);
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

export default router;
