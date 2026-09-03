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
  bulkUsersSchema,
  addModeratorNoteSchema,
  grantVerificationSchema,
  revokeVerificationSchema,
} from "../utils/validators.js";
import {
  listUsersForAdmin,
  updateUserRole,
  suspendUser,
  banUser,
  unrestrictUser,
  warnUser,
  updateUserPermissions,
  bulkUpdateUsers,
  listAuditLogs,
  grantVerification,
  revokeVerification,
} from "../controllers/adminController.js";
import {
  addModeratorNoteHandler,
  listModeratorNotesHandler,
  deleteModeratorNoteHandler,
  getUserCaseHistoryHandler,
} from "../controllers/moderatorNoteController.js";

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

// Phase 6 — bulk restriction from the admin panel's selection bar.
// Admin-only (mass actions are exactly what granular permissions must
// never leak); per-user results come back so partial failures surface.
router.post(
  "/users/bulk",
  protect,
  requireAdmin,
  validate(bulkUsersSchema),
  bulkUpdateUsers,
);

// Verification badges (Phase 1) — own permission, deliberately not
// manage_users. See adminController.grantVerification for the
// staff-can't-be-granted-here guard.
router.post(
  "/users/:id/verification",
  protect,
  requirePermission("manage_verification"),
  validate(grantVerificationSchema),
  grantVerification,
);
router.delete(
  "/users/:id/verification/:type",
  protect,
  requirePermission("manage_verification"),
  validate(revokeVerificationSchema),
  revokeVerification,
);

// Phase 7 (roadmap 3.6) — moderator notes + one-screen case history.
// Same manage_users gate as suspend/unrestrict: notes are a moderation
// tool, not a plain-user-reachable surface. Deleting is scoped inside
// the controller (own notes only, unless admin).
router.get(
  "/users/:id/case-history",
  protect,
  requireModerator,
  requirePermission("manage_users"),
  getUserCaseHistoryHandler,
);
router.get(
  "/users/:id/notes",
  protect,
  requireModerator,
  requirePermission("manage_users"),
  listModeratorNotesHandler,
);
router.post(
  "/users/:id/notes",
  protect,
  requireModerator,
  requirePermission("manage_users"),
  validate(addModeratorNoteSchema),
  addModeratorNoteHandler,
);
router.delete(
  "/users/:id/notes/:noteId",
  protect,
  requireModerator,
  requirePermission("manage_users"),
  deleteModeratorNoteHandler,
);

export default router;
