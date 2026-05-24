import express from "express";

import protect from "../middleware/authMiddleware.js";

import {
  addComment,
  getComments,
  deleteComment,
} from "../controllers/commentController.js";

const router = express.Router();

router.post("/:id", protect, addComment);
router.delete("/:id", protect, deleteComment);
router.get("/:id", protect, getComments);

export default router;
