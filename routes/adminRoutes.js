import express from "express";

import protect from "../middleware/authMiddleware.js";
import requireAdmin from "../middleware/requireAdmin.js";
import requireModerator from "../middleware/requireModerator.js";
import requirePermission from "../middleware/requirePermission.js";
import { validate } from "../utils/validators.js";
import {
  updateRoleSchema,
  suspendUserSchema,
  banUserSchema,
  warnUserSchema,
  updatePermissionsSchema,
} from "../utils/validators.js";
import {
  listUsersForAdmin,
  updateUserRole,
  suspendUser,
  banUser,
  unrestrictUser,
  warnUser,
  updateUserPermissions,
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
// Phase 5: coarse requireModerator stays as the shape guard, then
// manage_users decides. Default moderators hold it via
// DEFAULT_MODERATOR_PERMISSIONS -- a refinement, not a behavior change.
router.put(
  "/users/:id/suspend",
  protect,
  requireModerator,
  requirePermission("manage_users"),
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

router.put(
  "/users/:id/unrestrict",
  protect,
  requireModerator,
  requirePermission("manage_users"),
  unrestrictUser,
);

// Audit trail (Phase 3), granular since Phase 5: admins always pass the
// permission gate; moderators can be granted view_audit_log explicitly
// (the checkbox in Manage roles). Plain users fail both checks.
router.get("/audit", protect, requirePermission("view_audit_log"), listAuditLogs);

// Phase 5 -- set a moderator's explicit permission array (admin only,
// whole-array replacement). See updateUserPermissions for the guards.
router.put(
  "/users/:id/permissions",
  protect,
  requireAdmin,
  validate(updatePermissionsSchema),
  updateUserPermissions,
);

export default router;
