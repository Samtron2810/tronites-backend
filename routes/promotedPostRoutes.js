import express from "express";
import protect from "../middleware/authMiddleware.js";
import { validate } from "../utils/validators.js";
import { promotePostSchema } from "../utils/validators.js";
import {
  getPromotionFees,
  initiatePromotion,
  verifyPromotion,
  cancelPromotion,
} from "../controllers/promotedPostController.js";

// Paid post promotion (business tier). Mounted by index.js at
// /api/posts/promote BEFORE postRoutes so the literal /fees, /initiate,
// /verify/:reference and /cancel/:postId segments never fall through to a
// post :id.
const router = express.Router();

router.get("/fees", protect, getPromotionFees);
router.post("/initiate", protect, validate(promotePostSchema), initiatePromotion);
router.get("/verify/:reference", protect, verifyPromotion);
// Clears a stuck promotionReference after a failed/abandoned payment so the
// user can retry. Owner-only; rejected if the post is already promoted.
router.delete("/cancel/:postId", protect, cancelPromotion);

export default router;
