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
  listVerificationRequestsHandler,
  resolveVerificationRequestHandler,
} from "../controllers/verificationController.js";

const router = express.Router();

// Applicant-facing
router.post(
  "/",
  protect,
  validate(submitVerificationRequestSchema),
  submitVerificationRequestHandler,
);
router.get("/mine", protect, listMyVerificationRequestsHandler);
router.get("/eligibility", protect, checkEligibilityHandler);

// Reviewer queue
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
