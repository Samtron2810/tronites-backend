import express from "express";

import protect from "../middleware/authMiddleware.js";
import requireModerator from "../middleware/requireModerator.js";
import requirePermission from "../middleware/requirePermission.js";
import { validate } from "../utils/validators.js";
import {
  submitAppealSchema,
  appealStatusSchema,
  resolveAppealSchema,
} from "../utils/validators.js";
import {
  submitAppealHandler,
  getMyAppealStatusHandler,
  listAppealsHandler,
  resolveAppealHandler,
} from "../controllers/appealController.js";
import { appealLimiter } from "../middleware/rateLimiter.js";

const router = express.Router();

// No `protect` on these two — a restricted account is rejected by
// `protect` (and by loginUser) before it can ever hold a session, so
// submitting/checking an appeal has to re-prove identity with credentials
// instead of a cookie. Both are heavily rate-limited for that reason.
router.post(
  "/",
  appealLimiter,
  validate(submitAppealSchema),
  submitAppealHandler,
);
router.post(
  "/status",
  appealLimiter,
  validate(appealStatusSchema),
  getMyAppealStatusHandler,
);

// Moderation queue — same manage_users permission as suspend/unrestrict,
// since granting an appeal is exactly "unrestrict" with a paper trail.
router.get(
  "/",
  protect,
  requireModerator,
  requirePermission("manage_users"),
  listAppealsHandler,
);
router.put(
  "/:id/resolve",
  protect,
  requireModerator,
  requirePermission("manage_users"),
  validate(resolveAppealSchema),
  resolveAppealHandler,
);

export default router;
