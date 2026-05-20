import express from "express";
import protect from "../middleware/authMiddleware.js";
import upload from "../middleware/uploadMiddleware.js";
import {
  createPost,
  getFeedPosts,
  likePost,
} from "../controllers/postController.js";

const router = express.Router();

router.post("/", protect, upload.single("image"), createPost);
router.post("/like/:id", protect, likePost);
router.put("/like/:id", protect, likePost);
router.get("/", protect, getFeedPosts);
router.get("/feed", protect, getFeedPosts);

export default router;
