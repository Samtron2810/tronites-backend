import express from "express";

import protect from "../middleware/authMiddleware.js";
import { validate } from "../utils/validators.js";
import { createCommentSchema } from "../utils/validators.js";
import { commentLimiter } from "../middleware/rateLimiter.js";

import {
  addComment,
  getComments,
  deleteComment,
} from "../controllers/commentController.js";

const router = express.Router();

router.post(
  "/:id",
  protect,
  commentLimiter,
  validate(createCommentSchema),
  addComment,
);
router.delete("/:id", protect, deleteComment);
router.get("/:id", protect, getComments);

export default router;
