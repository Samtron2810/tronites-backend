import express from "express";
import protect from "../middleware/authMiddleware.js";
import upload from "../middleware/uploadMiddleware.js";
import {
  getConversations,
  getMessages,
  sendMessage,
  deleteMessage,
} from "../controllers/messageController.js";

const router = express.Router();

router.get("/conversations", protect, getConversations);
router.get("/:userId", protect, getMessages);
router.post("/:userId", protect, upload.single("image"), sendMessage);
router.delete("/:messageId", protect, deleteMessage);

export default router;
