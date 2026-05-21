import express from "express";
import protect from "../middleware/authMiddleware.js";
import upload from "../middleware/uploadMiddleware.js";
import {
  createPost,
  getFeedPosts,
  likePost,
  deletePost,
} from "../controllers/postController.js";

const router = express.Router();

router.post("/", protect, upload.single("image"), createPost);

router.put("/like/:id", protect, likePost);

router.get("/feed", protect, getFeedPosts);

router.delete("/:id", protect, deletePost);

export default router;
