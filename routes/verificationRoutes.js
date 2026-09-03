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
  listVerificationRequestsHandler,
  resolveVerificationRequestHandler,
} from "../controllers/verificationController.js";

const router = express.Router();

// Applicant-facing — unlike Appeal these are always `protect`-gated: a
// user applying for a badge is by definition not a restricted account
// with no session, so there's no need for Appeal's credential-reproof
// workaround.
router.post(
  "/",
  protect,
  validate(submitVerificationRequestSchema),
  submitVerificationRequestHandler,
);
router.get("/mine", protect, listMyVerificationRequestsHandler);

// Reviewer queue — same manage_verification permission as the direct
// grant/revoke endpoints in adminRoutes.js, since approving a request is
// exactly "grant" with a paper trail.
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
