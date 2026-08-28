import express from "express";
import protect from "../middleware/authMiddleware.js";
import {
  createPost,
  createImageUploadSignature,
  createVideoUploadSignature,
  createVideoPost,
  editPost,
  getFeedPosts,
  getTrendingPosts,
  getTrendingHashtags,
  searchPosts,
  likePost,
  toggleBookmark,
  toggleRepost,
  createQuotePost,
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
  createQuoteSchema,
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
// Toggle repost (create/undo) — same PUT-as-toggle convention as
// like/bookmark above, not a separate POST+DELETE pair.
router.put("/repost/:id", protect, postLimiter, toggleRepost);
// Quote is POST, not PUT — unlike repost/like/bookmark it's not a
// simple on/off toggle, it creates a genuinely new authored item each
// time (mirrors POST /posts for a normal post).
router.post(
  "/quote/:id",
  protect,
  postLimiter,
  validate(createQuoteSchema),
  createQuotePost,
);
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
router.get("/trending", protect, getTrendingPosts);
router.get("/trending-hashtags", protect, getTrendingHashtags);
router.get("/search", protect, searchPosts);
router.get(
  "/hashtag/:tag",
  protect,
  validateQuery(paginationSchema),
  getPostsByHashtag,
);

router.delete("/:id", protect, deletePost);

export default router;
