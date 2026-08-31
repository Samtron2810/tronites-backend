import express from "express";

import protect from "../middleware/authMiddleware.js";
import { validate } from "../utils/validators.js";
import { createCommentSchema } from "../utils/validators.js";
import { commentLimiter } from "../middleware/rateLimiter.js";

import {
  addComment,
  likeComment,
  getComments,
  deleteComment,
  getReplies,
  searchComments,
} from "../controllers/commentController.js";

const router = express.Router();

// Above the "/:id" catch-all GETs below — same literal-route-before-
// dynamic-param reasoning as postRoutes.js's "/search".
router.get("/search", protect, searchComments);

router.post(
  "/:id",
  protect,
  commentLimiter,
  validate(createCommentSchema),
  addComment,
);
router.put("/like/:id", protect, likeComment);
router.delete("/:id", protect, deleteComment);
router.get("/:id", protect, getComments);
router.get("/:id/replies", protect, getReplies);

export default router;
