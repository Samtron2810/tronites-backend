import express from "express";
import protect from "../middleware/authMiddleware.js";
import { uploadMultiple } from "../middleware/uploadMiddleware.js";
import { validate, validateQuery } from "../utils/validators.js";
import {
  sendMessageSchema,
  paginationSchema,
  messageVideoSignatureSchema,
  sendVideoMessageSchema,
  messageVoiceSignatureSchema,
  sendVoiceMessageSchema,
  reactSchema,
} from "../utils/validators.js";
import { messageLimiter } from "../middleware/rateLimiter.js";
import {
  getConversations,
  getMessages,
  sendMessage,
  deleteMessage,
  reactToMessage,
  getMessageRequests,
  respondToRequest,
  createMessageVideoUploadSignature,
  sendVideoMessage,
  createMessageVoiceUploadSignature,
  sendVoiceMessage,
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

// Signed browser upload: request a signature for a direct chat-video upload.
// No message is created here — see POST /:userId/video below. Registered
// before the dynamic `/:userId`/`/:userId/video` routes so the literal
// "signature" segment is never treated as a user id.
router.post(
  "/signature/video",
  protect,
  messageLimiter,
  validate(messageVideoSignatureSchema),
  createMessageVideoUploadSignature,
);

// Same "before the dynamic /:userId routes" reasoning as /signature/video.
router.post(
  "/signature/voice",
  protect,
  messageLimiter,
  validate(messageVoiceSignatureSchema),
  createMessageVoiceUploadSignature,
);

router.get("/:userId", protect, validateQuery(paginationSchema), getMessages);

// Custom uploader flow: create the video message AFTER the browser has
// uploaded the asset directly to Cloudinary (signed via /signature/video).
// The controller validates the asset belongs to our cloud + folder.
router.post(
  "/:userId/video",
  protect,
  messageLimiter,
  validate(sendVideoMessageSchema),
  sendVideoMessage,
);

// Same flow as above, for a recorded voice note (signed via
// /signature/voice).
router.post(
  "/:userId/voice",
  protect,
  messageLimiter,
  validate(sendVoiceMessageSchema),
  sendVoiceMessage,
);

router.post(
  "/:userId",
  protect,
  messageLimiter,
  uploadMultiple.array("images", 4),
  validate(sendMessageSchema),
  sendMessage,
);
router.delete("/:messageId", protect, deleteMessage);
// Emoji reaction on a message bubble — same PUT-as-set-state convention
// as postRoutes' /react/:id. No dedicated rate limiter: reactions are
// cheap, idempotent-per-emoji writes, same reasoning as post likes not
// having one either.
router.put(
  "/:messageId/react",
  protect,
  validate(reactSchema),
  reactToMessage,
);

export default router;
