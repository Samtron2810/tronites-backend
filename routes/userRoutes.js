import express from "express";

import protect from "../middleware/authMiddleware.js";
import upload from "../middleware/uploadMiddleware.js";
import { validate } from "../utils/validators.js";
import { updateBioSchema, setUsernameSchema } from "../utils/validators.js";

import {
  followUser,
  getUserProfile,
  searchUsers,
  updateProfilePicture,
  updateBio,
  getFollowers,
  getFollowing,
  checkUsername,
  setUsername,
  resolveUsername,
} from "../controllers/userController.js";

const router = express.Router();

router.get("/check-username", protect, checkUsername);
router.put("/username", protect, validate(setUsernameSchema), setUsername);
router.get("/u/:username", protect, resolveUsername);
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
router.get("/followers/:id", protect, getFollowers);
router.get("/following/:id", protect, getFollowing);

export default router;
