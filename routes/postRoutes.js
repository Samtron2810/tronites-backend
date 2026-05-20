import express from "express";

import protect from "../middleware/authMiddleware.js";

import {
  createPost,
  getFeedPosts,
  likePost,
} from "../controllers/postController.js";

const router = express.Router();

router.post("/", protect, createPost);
router.post("/like/:id", protect, likePost);

router.put("/like/:id", protect, likePost);
router.get("/", protect, getFeedPosts);
//PERSONALIZED FEED
router.get("/feed", protect, getFeedPosts);

export default router;
