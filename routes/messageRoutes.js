import express from "express";
import protect from "../middleware/authMiddleware.js";
import upload from "../middleware/uploadMiddleware.js";
import { validate } from "../utils/validators.js";
import { sendMessageSchema } from "../utils/validators.js";
import { messageLimiter } from "../middleware/rateLimiter.js";
import {
  getConversations,
  getMessages,
  sendMessage,
  deleteMessage,
} from "../controllers/messageController.js";

const router = express.Router();

router.get("/conversations", protect, getConversations);
router.get("/:userId", protect, getMessages);
router.post(
  "/:userId",
  protect,
  messageLimiter,
  upload.single("image"),
  validate(sendMessageSchema),
  sendMessage,
);
router.delete("/:messageId", protect, deleteMessage);

export default router;
