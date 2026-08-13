import express from "express";
import protect from "../middleware/authMiddleware.js";
import { uploadMultiple } from "../middleware/uploadMiddleware.js";
import {
  createPost,
  getFeedPosts,
  likePost,
  deletePost,
  getPostsByHashtag,
} from "../controllers/postController.js";
import { validate, validateQuery } from "../utils/validators.js";
import { createPostSchema, paginationSchema } from "../utils/validators.js";
import { postLimiter } from "../middleware/rateLimiter.js";

const router = express.Router();

router.post(
  "/",
  protect,
  postLimiter,
  uploadMultiple.array("images", 4),
  validate(createPostSchema),
  createPost,
);

router.put("/like/:id", protect, likePost);

router.get("/feed", protect, validateQuery(paginationSchema), getFeedPosts);
router.get(
  "/hashtag/:tag",
  protect,
  validateQuery(paginationSchema),
  getPostsByHashtag,
);

router.delete("/:id", protect, deletePost);

export default router;
