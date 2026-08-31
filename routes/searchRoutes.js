import express from "express";
import protect from "../middleware/authMiddleware.js";
import {
  logSearchHistory,
  getSearchHistory,
  deleteSearchHistoryEntry,
  clearSearchHistory,
  saveSearch,
  getSavedSearches,
  deleteSavedSearch,
} from "../controllers/savedSearchController.js";

const router = express.Router();

router.post("/history", protect, logSearchHistory);
router.get("/history", protect, getSearchHistory);
router.delete("/history", protect, clearSearchHistory);
router.delete("/history/:id", protect, deleteSearchHistoryEntry);

router.post("/saved", protect, saveSearch);
router.get("/saved", protect, getSavedSearches);
router.delete("/saved/:id", protect, deleteSavedSearch);

export default router;
