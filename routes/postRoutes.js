import express from "express";
import protect from "../middleware/authMiddleware.js";
import {
  createPost,
  createImageUploadSignature,
  createVideoUploadSignature,
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
import {
  createPostSchema,
  createImageSignatureSchema,
  createVideoSignatureSchema,
  createVideoPostSchema,
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

// Signed browser upload: request a signature for a direct video upload.
// No post is created here — see POST /video below.
router.post(
  "/signature/video",
  protect,
  postLimiter,
  validate(createVideoSignatureSchema),
  createVideoUploadSignature,
);

// Custom uploader flow: create the video post AFTER the browser has
// uploaded the asset directly to Cloudinary (signed via /signature/video).
// The controller validates the asset belongs to our cloud + folder.
router.post(
  "/video",
  protect,
  postLimiter,
  validate(createVideoPostSchema),
  createVideoPost,
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
