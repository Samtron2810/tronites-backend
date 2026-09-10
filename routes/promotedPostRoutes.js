import express from "express";
import protect from "../middleware/authMiddleware.js";
import { validate } from "../utils/validators.js";
import { promotePostSchema } from "../utils/validators.js";
import {
  getPromotionFees,
  initiatePromotion,
  verifyPromotion,
} from "../controllers/promotedPostController.js";

// Paid post promotion (business tier). Mounted by index.js at
// /api/posts/promote BEFORE postRoutes so the literal /fees, /initiate and
// /verify/:reference segments never fall through to a post :id.
const router = express.Router();

router.get("/fees", protect, getPromotionFees);
router.post("/initiate", protect, validate(promotePostSchema), initiatePromotion);
router.get("/verify/:reference", protect, verifyPromotion);

export default router;