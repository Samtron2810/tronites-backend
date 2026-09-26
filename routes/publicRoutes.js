import express from "express";

import optionalProtect from "../middleware/optionalProtect.js";
import { getPublicUserProfile } from "../controllers/publicUserController.js";
import { getPublicPostById } from "../controllers/publicPostController.js";
import { getPublicPostsByHashtag } from "../controllers/publicHashtagController.js";
import { getPublicExplore } from "../controllers/publicExploreController.js";

const router = express.Router();

// GET /api/public/profiles/:username — Phase 3
router.get("/profiles/:username", optionalProtect, getPublicUserProfile);

// GET /api/public/posts/:id — Phase 4
router.get("/posts/:id", optionalProtect, getPublicPostById);

// GET /api/public/hashtags/:tag — Phase 4
router.get("/hashtags/:tag", optionalProtect, getPublicPostsByHashtag);

// GET /api/public/explore — Phase 4
router.get("/explore", optionalProtect, getPublicExplore);

export default router;
