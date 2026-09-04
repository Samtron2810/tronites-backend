import express from "express";
import protect from "../middleware/authMiddleware.js";
import requireModerator from "../middleware/requireModerator.js";
import requirePermission from "../middleware/requirePermission.js";
import { validate } from "../utils/validators.js";
import {
  submitVerificationRequestSchema,
  resolveVerificationRequestSchema,
} from "../utils/validators.js";
import {
  submitVerificationRequestHandler,
  listMyVerificationRequestsHandler,
  checkEligibilityHandler,
  getFeeInfoHandler,
  initiatePaymentHandler,
  verifyPaymentHandler,
  listVerificationRequestsHandler,
  resolveVerificationRequestHandler,
} from "../controllers/verificationController.js";

const router = express.Router();

// ── Public ────────────────────────────────────────────────────────────
// Fee info — no auth, so the badge picker can show "₦5,000 required"
// before the user even starts.
router.get("/fees", getFeeInfoHandler);

// ── Applicant-facing ──────────────────────────────────────────────────
router.get("/mine", protect, listMyVerificationRequestsHandler);
router.get("/eligibility", protect, checkEligibilityHandler);

// Payment (business badge)
router.post("/payment/initiate", protect, initiatePaymentHandler);
router.get("/payment/verify/:reference", protect, verifyPaymentHandler);

// Submit application
router.post(
  "/",
  protect,
  validate(submitVerificationRequestSchema),
  submitVerificationRequestHandler,
);

// ── Reviewer queue ────────────────────────────────────────────────────
router.get(
  "/",
  protect,
  requireModerator,
  requirePermission("manage_verification"),
  listVerificationRequestsHandler,
);
router.put(
  "/:id/resolve",
  protect,
  requireModerator,
  requirePermission("manage_verification"),
  validate(resolveVerificationRequestSchema),
  resolveVerificationRequestHandler,
);

export default router;
