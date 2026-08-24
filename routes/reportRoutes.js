import express from "express";

import protect from "../middleware/authMiddleware.js";
import requireModerator from "../middleware/requireModerator.js";
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
router.get("/", protect, requireModerator, listReportsHandler);
// Full flagged item for the in-queue preview modal — on-demand and
// moderator-gated so raw post/comment/message content (including private
// conversation windows) is only ever fetched when a moderator opens it.
router.get("/:id/context", protect, requireModerator, getReportContextHandler);
router.put(
  "/:id/resolve",
  protect,
  requireModerator,
  validate(resolveReportSchema),
  resolveReportHandler,
);

export default router;
