import express from "express";

import protect from "../middleware/authMiddleware.js";
import upload from "../middleware/uploadMiddleware.js";
import { validate } from "../utils/validators.js";
import { updateBioSchema } from "../utils/validators.js";

import {
  followUser,
  getUserProfile,
  searchUsers,
  updateProfilePicture,
  updateBio,
} from "../controllers/userController.js";

const router = express.Router();

router.put("/follow/:id", protect, followUser);
router.get("/profile/:id", protect, getUserProfile);
router.get("/search", protect, searchUsers);
router.put(
  "/profile-picture",
  protect,
  upload.single("image"),
  updateProfilePicture,
);
router.put("/bio", protect, validate(updateBioSchema), updateBio);

export default router;
