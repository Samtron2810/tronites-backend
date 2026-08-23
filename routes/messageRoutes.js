import express from "express";
import protect from "../middleware/authMiddleware.js";
import { uploadMultiple } from "../middleware/uploadMiddleware.js";
import { validate, validateQuery } from "../utils/validators.js";
import { sendMessageSchema, paginationSchema } from "../utils/validators.js";
import { messageLimiter } from "../middleware/rateLimiter.js";
import {
  getConversations,
  getMessages,
  sendMessage,
  deleteMessage,
  getMessageRequests,
  respondToRequest,
} from "../controllers/messageController.js";

const router = express.Router();

router.get(
  "/conversations",
  protect,
  validateQuery(paginationSchema),
  getConversations,
);
router.get("/requests", protect, getMessageRequests);
router.put("/requests/:userId", protect, respondToRequest);
router.get("/:userId", protect, validateQuery(paginationSchema), getMessages);
router.post(
  "/:userId",
  protect,
  messageLimiter,
  uploadMultiple.array("images", 4),
  validate(sendMessageSchema),
  sendMessage,
);
router.delete("/:messageId", protect, deleteMessage);

export default router;
