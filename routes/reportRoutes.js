import express from "express";

import protect from "../middleware/authMiddleware.js";
import requireModerator from "../middleware/requireModerator.js";
import requirePermission from "../middleware/requirePermission.js";
import { validate } from "../utils/validators.js";
import { createReportSchema, resolveReportSchema } from "../utils/validators.js";
import {
  createReportHandler,
  listReportsHandler,
  resolveReportHandler,
  getReportContextHandler,
} from "../controllers/reportController.js";

const router = express.Router();

router.post("/", protect, validate(createReportSchema), createReportHandler);
// Phase 5 — queue reads/resolve now demand the manage_reports permission
// (admins short-circuit inside; moderators need it explicitly or via the
// empty-array legacy default). requireModerator is dropped here because
// requirePermission already rejects plain users via the missing-permission
// path — no moderator role, no default set, no pass.
router.get("/", protect, requirePermission("manage_reports"), listReportsHandler);
// Full flagged item for the in-queue preview modal — on-demand and
// gated so raw post/comment/message content (including private
// conversation windows) is only ever fetched when a moderator opens it.
router.get(
  "/:id/context",
  protect,
  requirePermission("manage_reports"),
  getReportContextHandler,
);
router.put(
  "/:id/resolve",
  protect,
  requirePermission("manage_reports"),
  validate(resolveReportSchema),
  resolveReportHandler,
);

export default router;
