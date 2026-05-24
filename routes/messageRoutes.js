import express from "express";
import protect from "../middleware/authMiddleware.js";
import {
  getConversations,
  getMessages,
  sendMessage,
  deleteMessage,
} from "../controllers/messageController.js";

const router = express.Router();

router.get("/conversations", protect, getConversations);
router.get("/:userId", protect, getMessages);
router.post("/:userId", protect, sendMessage);
router.delete("/:messageId", protect, deleteMessage);

export default router;
