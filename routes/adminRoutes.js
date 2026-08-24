import express from "express";

import protect from "../middleware/authMiddleware.js";
import requireAdmin from "../middleware/requireAdmin.js";
import requireModerator from "../middleware/requireModerator.js";
import { validate } from "../utils/validators.js";
import {
  updateRoleSchema,
  suspendUserSchema,
  banUserSchema,
  warnUserSchema,
} from "../utils/validators.js";
import {
  listUsersForAdmin,
  updateUserRole,
  suspendUser,
  banUser,
  unrestrictUser,
  warnUser,
  listAuditLogs,
} from "../controllers/adminController.js";

const router = express.Router();

// Role management — admin only (see requireAdmin: granting/revoking
// moderator status must never be reachable by moderators themselves).
router.get("/users", protect, requireAdmin, listUsersForAdmin);
router.put(
  "/users/:id/role",
  protect,
  requireAdmin,
  validate(updateRoleSchema),
  updateUserRole,
);

// Account restrictions (Phase 2). Suspension and its reversal are
// moderator-level actions; banning is the higher-stakes step and stays
// admin-only. Further target guards (no self-action, admins exempt,
// moderator-vs-moderator block) live in the controller so both routes
// share one rulebook.
router.put(
  "/users/:id/suspend",
  protect,
  requireModerator,
  validate(suspendUserSchema),
  suspendUser,
);
router.put(
  "/users/:id/ban",
  protect,
  requireAdmin,
  validate(banUserSchema),
  banUser,
);
// Phase 4 -- formal warning (strike). Moderator-level like suspension;
// the response flags when the strike threshold is crossed so the UI can
// prompt the moderator toward the suspend flow.
router.post(
  "/users/:id/warn",
  protect,
  requireModerator,
  validate(warnUserSchema),
  warnUser,
);

router.put("/users/:id/unrestrict", protect, requireModerator, unrestrictUser);

// Audit trail (Phase 3). Read access is deliberately stricter than the
// write side: moderators and admins both generate entries, but only
// admins get to review everyone's actions.
router.get("/audit", protect, requireAdmin, listAuditLogs);

export default router;
