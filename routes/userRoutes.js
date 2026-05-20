import express from "express";

import protect from "../middleware/authMiddleware.js";

import {
  followUser,
  getUserProfile,
  searchUsers,
} from "../controllers/userController.js";

const router = express.Router();

router.put("/follow/:id", protect, followUser);
router.get("/profile/:id", protect, getUserProfile);
router.get("/search", protect, searchUsers);

export default router;
