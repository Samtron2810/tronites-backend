import express from "express";

import protect from "../middleware/authMiddleware.js";
import requireModerator from "../middleware/requireModerator.js";
import { validate } from "../utils/validators.js";
import { createReportSchema, resolveReportSchema } from "../utils/validators.js";
import {
  createReportHandler,
  listReportsHandler,
  resolveReportHandler,
} from "../controllers/reportController.js";

const router = express.Router();

router.post("/", protect, validate(createReportSchema), createReportHandler);
router.get("/", protect, requireModerator, listReportsHandler);
router.put(
  "/:id/resolve",
  protect,
  requireModerator,
  validate(resolveReportSchema),
  resolveReportHandler,
);

export default router;
