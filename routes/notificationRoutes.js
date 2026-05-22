import express from "express";
import protect from "../middleware/authMiddleware.js";
import {
  getNotifications,
  markAllRead,
  getUnreadCount,
} from "../controllers/notificationController.js";

const router = express.Router();

router.get("/", protect, getNotifications);
router.get("/unread-count", protect, getUnreadCount);
router.put("/mark-read", protect, markAllRead);

export default router;
