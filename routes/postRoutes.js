import express from "express";
import protect from "../middleware/authMiddleware.js";
import { uploadMultiple, uploadVideo } from "../middleware/uploadMiddleware.js";
import {
  createPost,
  createVideoPost,
  editPost,
  getFeedPosts,
  searchPosts,
  likePost,
  toggleBookmark,
  getBookmarkedPosts,
  deletePost,
  getPostsByHashtag,
} from "../controllers/postController.js";
import { validate, validateQuery } from "../utils/validators.js";
import { createPostSchema, editPostSchema, paginationSchema } from "../utils/validators.js";
import { postLimiter, editPostLimiter } from "../middleware/rateLimiter.js";

const router = express.Router();

router.post(
  "/",
  protect,
  postLimiter,
  uploadMultiple.array("images", 4),
  validate(createPostSchema),
  createPost,
);

router.post(
  "/video",
  protect,
  postLimiter,
  uploadVideo.single("video"),
  validate(createPostSchema),
  createVideoPost,
);

router.put("/like/:id", protect, likePost);
router.put("/bookmark/:id", protect, toggleBookmark);
router.get("/bookmarks", protect, validateQuery(paginationSchema), getBookmarkedPosts);

router.put(
  "/:id",
  protect,
  editPostLimiter,
  validate(editPostSchema),
  editPost,
);

router.get("/feed", protect, validateQuery(paginationSchema), getFeedPosts);
router.get("/search", protect, searchPosts);
router.get(
  "/hashtag/:tag",
  protect,
  validateQuery(paginationSchema),
  getPostsByHashtag,
);

router.delete("/:id", protect, deletePost);

export default router;
