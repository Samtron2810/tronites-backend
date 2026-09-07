import express from "express";
import protect from "../middleware/authMiddleware.js";
import requireCreator from "../middleware/requireCreator.js";
import {
  getOverview,
  getEngagementSeries,
  getTopPosts,
  getPostingCadence,
  getFollowerMilestone,
} from "../controllers/analyticsController.js";

const router = express.Router();

// All analytics routes require auth + active creator badge.
router.use(protect, requireCreator);

router.get("/overview", getOverview);
router.get("/engagement", getEngagementSeries);
router.get("/top-posts", getTopPosts);
router.get("/posting-cadence", getPostingCadence);
router.get("/follower-milestone", getFollowerMilestone);

export default router;
