import express from "express";
import protect from "../middleware/authMiddleware.js";
import requireCreator from "../middleware/requireCreator.js";
import {
  getOverview,
  getEngagementSeries,
  getTopPosts,
  getPostingCadence,
  getFollowerMilestone,
  getTopFans,
  getHashtagPerformance,
  getBestTimeToPost,
  getFollowerGrowth,
} from "../controllers/analyticsController.js";

const router = express.Router();

// All analytics routes require auth + active creator badge.
router.use(protect, requireCreator);

router.get("/overview", getOverview);
router.get("/engagement", getEngagementSeries);
router.get("/top-posts", getTopPosts);
router.get("/posting-cadence", getPostingCadence);
router.get("/follower-milestone", getFollowerMilestone);
router.get("/top-fans", getTopFans);
router.get("/hashtag-performance", getHashtagPerformance);
router.get("/best-time-to-post", getBestTimeToPost);
router.get("/follower-growth", getFollowerGrowth);

export default router;
