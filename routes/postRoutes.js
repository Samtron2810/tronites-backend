import express from "express";
import protect from "../middleware/authMiddleware.js";
import upload from "../middleware/uploadMiddleware.js";
import {
  createPost,
  getFeedPosts,
  likePost,
  deletePost,
} from "../controllers/postController.js";
import { validate, validateQuery } from "../utils/validators.js";
import { createPostSchema, paginationSchema } from "../utils/validators.js";
import { postLimiter } from "../middleware/rateLimiter.js";

const router = express.Router();

router.post(
  "/",
  protect,
  postLimiter,
  upload.single("image"),
  validate(createPostSchema),
  createPost,
);

router.put("/like/:id", protect, likePost);

router.get("/feed", protect, validateQuery(paginationSchema), getFeedPosts);

router.delete("/:id", protect, deletePost);

export default router;
