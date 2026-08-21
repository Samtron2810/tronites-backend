import express from "express";
import protect from "../middleware/authMiddleware.js";
import {
  createPost,
  createImageUploadSignature,
  createVideoUploadSignature,
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
import {
  createPostSchema,
  createImageSignatureSchema,
  createVideoSignatureSchema,
  editPostSchema,
  paginationSchema,
} from "../utils/validators.js";
import { postLimiter, editPostLimiter } from "../middleware/rateLimiter.js";

const router = express.Router();

// Signed browser upload: images arrive as Cloudinary URLs in the body.
router.post("/", protect, postLimiter, validate(createPostSchema), createPost);

// Signed browser upload: request a signature for image uploads.
router.post(
  "/signature/image",
  protect,
  postLimiter,
  validate(createImageSignatureSchema),
  createImageUploadSignature,
);

// Signed browser upload: create the post shell and request a signature
// for the video upload. The frontend uploads the video directly to
// Cloudinary; the webhook flips the post to "ready" when done.
router.post(
  "/signature/video",
  protect,
  postLimiter,
  validate(createVideoSignatureSchema),
  createVideoUploadSignature,
);

router.put("/like/:id", protect, likePost);
router.put("/bookmark/:id", protect, toggleBookmark);
router.get(
  "/bookmarks",
  protect,
  validateQuery(paginationSchema),
  getBookmarkedPosts,
);

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
