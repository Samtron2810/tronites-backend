import express from "express";
import protect from "../middleware/authMiddleware.js";
import { validateQuery } from "../utils/validators.js";
import { paginationSchema } from "../utils/validators.js";
import {
  getNotifications,
  markAllRead,
  getUnreadCount,
} from "../controllers/notificationController.js";

const router = express.Router();

router.get(
  "/",
  protect,
  validateQuery(paginationSchema),
  getNotifications,
);
router.get("/unread-count", protect, getUnreadCount);
router.put("/mark-read", protect, markAllRead);

export default router;
