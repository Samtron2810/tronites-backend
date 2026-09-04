import express from "express";

import protect from "../middleware/authMiddleware.js";
import { accountDeletionLimiter } from "../middleware/rateLimiter.js";
import { validate } from "../utils/validators.js";
import { deleteAccountSchema } from "../utils/validators.js";
import { updateBioSchema, setUsernameSchema, updateNameSchema, presenceVisibilitySchema, updateProfilePictureSchema } from "../utils/validators.js";

import {
  followUser,
  getUserProfile,
  searchUsers,
  createProfilePictureUploadSignature,
  updateProfilePicture,
  updateName,
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
  deleteMyAccount,
  exportMyData,
} from "../controllers/userController.js";
import { getMuteStatus, muteUserHandler, unmuteUserHandler } from "../controllers/muteController.js";
import {
  listSessions,
  revokeSessionById,
  revokeOtherSessions,
} from "../controllers/sessionController.js";

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
// Signed browser upload (same flow as post images, see postRoutes.js):
// POST /profile-picture/signature returns signed Cloudinary params, the
// browser uploads the avatar directly to Cloudinary, then
// PUT /profile-picture carries just the finished asset's URL as JSON.
router.post(
  "/profile-picture/signature",
  protect,
  createProfilePictureUploadSignature,
);
router.put(
  "/profile-picture",
  protect,
  validate(updateProfilePictureSchema),
  updateProfilePicture,
);
router.put("/bio", protect, validate(updateBioSchema), updateBio);
router.put("/name", protect, validate(updateNameSchema), updateName);
router.put(
  "/presence-visibility",
  protect,
  validate(presenceVisibilitySchema),
  updatePresenceVisibility,
);
router.get("/followers/:id", protect, getFollowers);
router.get("/following/:id", protect, getFollowing);
router.get("/me/export", protect, exportMyData);
router.get("/me/sessions", protect, listSessions);
router.delete("/me/sessions/:id", protect, revokeSessionById);
router.delete("/me/sessions", protect, revokeOtherSessions);
router.delete("/me", protect, accountDeletionLimiter, validate(deleteAccountSchema), deleteMyAccount);

export default router;
