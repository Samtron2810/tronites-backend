import express from "express";

import protect from "../middleware/authMiddleware.js";
import upload from "../middleware/uploadMiddleware.js";
import { validate } from "../utils/validators.js";
import { updateBioSchema, setUsernameSchema, presenceVisibilitySchema } from "../utils/validators.js";

import {
  followUser,
  getUserProfile,
  searchUsers,
  updateProfilePicture,
  updateBio,
  updatePresenceVisibility,
  getFollowers,
  getFollowing,
  checkUsername,
  setUsername,
  resolveUsername,
  blockUser,
  unblockUser,
  getBlockStatus,
} from "../controllers/userController.js";
import { getMuteStatus, muteUserHandler, unmuteUserHandler } from "../controllers/muteController.js";

const router = express.Router();

router.get("/check-username", protect, checkUsername);
router.put("/username", protect, validate(setUsernameSchema), setUsername);
router.get("/u/:username", protect, resolveUsername);
router.put("/follow/:id", protect, followUser);
router.get("/:id/block-status", protect, getBlockStatus);
router.post("/:id/block", protect, blockUser);
router.delete("/:id/block", protect, unblockUser);
router.get("/:id/mute-status", protect, getMuteStatus);
router.post("/:id/mute", protect, muteUserHandler);
router.delete("/:id/mute", protect, unmuteUserHandler);
router.get("/profile/:id", protect, getUserProfile);
router.get("/search", protect, searchUsers);
router.put(
  "/profile-picture",
  protect,
  upload.single("image"),
  updateProfilePicture,
);
router.put("/bio", protect, validate(updateBioSchema), updateBio);
router.put(
  "/presence-visibility",
  protect,
  validate(presenceVisibilitySchema),
  updatePresenceVisibility,
);
router.get("/followers/:id", protect, getFollowers);
router.get("/following/:id", protect, getFollowing);

export default router;
