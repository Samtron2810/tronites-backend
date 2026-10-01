import express from "express";
import rateLimit from "express-rate-limit";

import protect from "../middleware/authMiddleware.js";
import requireModerator from "../middleware/requireModerator.js";
import requirePermission from "../middleware/requirePermission.js";
import {
  validate,
  previewBroadcastAudienceSchema,
  createBroadcastSchema,
  testBroadcastSchema,
  renderBroadcastSchema,
} from "../utils/validators.js";
import {
  previewAudience,
  renderPreview,
  searchRecipients,
  sendTest,
  createBroadcast,
  listBroadcasts,
  getBroadcast,
  cancelBroadcast,
  resumeBroadcast,
} from "../controllers/broadcastController.js";

const router = express.Router();

// Every route: authenticated moderator/admin holding send_broadcasts
// (admins pass implicitly — see middleware/requirePermission.js).
router.use(protect, requireModerator, requirePermission("send_broadcasts"));

const sendLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many send attempts. Wait a minute." },
});

router.get("/", listBroadcasts);
router.get("/users/search", searchRecipients);
router.post("/preview", validate(previewBroadcastAudienceSchema), previewAudience);
router.post("/render", validate(renderBroadcastSchema), renderPreview);
router.post("/test", sendLimiter, validate(testBroadcastSchema), sendTest);
router.post("/", sendLimiter, validate(createBroadcastSchema), createBroadcast);
router.get("/:id", getBroadcast);
router.post("/:id/cancel", cancelBroadcast);
router.post("/:id/resume", resumeBroadcast);

export default router;
