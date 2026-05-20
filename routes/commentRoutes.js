import express from "express";

import protect from "../middleware/authMiddleware.js";

import { addComment, getComments } from "../controllers/commentController.js";

const router = express.Router();

router.post("/:id", protect, addComment);

router.get("/:id", protect, getComments);

export default router;
