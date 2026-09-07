import Post from "../models/Post.js";
import Like from "../models/Like.js";
import Repost from "../models/Repost.js";
import Comment from "../models/Comment.js";
import Bookmark from "../models/Bookmark.js";
import Follow from "../models/Follow.js";
import { getOrSetCache } from "../utils/redis.js";

// TTLs (seconds) — analytics data is expensive to compute but can tolerate
// brief staleness. Overview/milestone are slow-changing (5 min). Time-series
// and top-posts rotate with `days` param so they're keyed accordingly (3 min).
// Best-time and top-fans change even slower (10 min). Posting cadence same as
// time-series. Follower growth mirrors engagement TTL.
const TTL = {
  overview: 300,       // 5 min
  engagement: 180,     // 3 min
  topPosts: 180,       // 3 min
  cadence: 180,        // 3 min
  milestone: 300,      // 5 min
  topFans: 600,        // 10 min
  hashtag: 180,        // 3 min
  bestTime: 600,       // 10 min
  followerGrowth: 180, // 3 min
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Returns start-of-day UTC Date for N days ago.
const daysAgo = (n) => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - n);
  return d;
};

// Fills in missing dates in a time-series with 0 so the chart always
// has a point for every day even when there was no activity.
const fillDailySeries = (rows, days) => {
  const map = new Map(rows.map((r) => [r.date, r.count]));
  return Array.from({ length: days }, (_, i) => {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() - (days - 1 - i));
    const key = d.toISOString().slice(0, 10);
    return { date: key, count: map.get(key) || 0 };
  });
};

// ---------------------------------------------------------------------------
// GET /analytics/overview
// ---------------------------------------------------------------------------
export const getOverview = async (req, res) => {
  try {
    const userId = req.user._id;
    const cacheKey = `analytics:overview:${userId}`;

    const data = await getOrSetCache(cacheKey, async () => {
      const since30d = daysAgo(30);

      const postIds = await Post.find({ user: userId, removedAt: null })
        .select("_id createdAt")
        .lean();

      const allPostIds = postIds.map((p) => p._id);
      const recentPostIds = postIds
        .filter((p) => p.createdAt >= since30d)
        .map((p) => p._id);

      const [
        totalLikes, totalComments, totalReposts, totalBookmarks, totalFollowers,
        recentLikes, recentComments, recentReposts, recentFollowers, recentPosts,
      ] = await Promise.all([
        Like.countDocuments({ post: { $in: allPostIds } }),
        Comment.countDocuments({ post: { $in: allPostIds }, removedAt: null }),
        Repost.countDocuments({ post: { $in: allPostIds } }),
        Bookmark.countDocuments({ post: { $in: allPostIds } }),
        Follow.countDocuments({ following: userId }),
        Like.countDocuments({ post: { $in: recentPostIds } }),
        Comment.countDocuments({ post: { $in: recentPostIds }, removedAt: null }),
        Repost.countDocuments({ post: { $in: recentPostIds } }),
        Follow.countDocuments({ following: userId, createdAt: { $gte: since30d } }),
        Post.countDocuments({ user: userId, removedAt: null, createdAt: { $gte: since30d } }),
      ]);

      return {
        totals: {
          posts: allPostIds.length,
          likes: totalLikes,
          comments: totalComments,
          reposts: totalReposts,
          bookmarks: totalBookmarks,
          followers: totalFollowers,
        },
        last30d: {
          posts: recentPosts,
          likes: recentLikes,
          comments: recentComments,
          reposts: recentReposts,
          followers: recentFollowers,
        },
      };
    }, TTL.overview);

    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ---------------------------------------------------------------------------
// GET /analytics/engagement?days=30
// ---------------------------------------------------------------------------
export const getEngagementSeries = async (req, res) => {
  try {
    const userId = req.user._id;
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 7), 90);
    const cacheKey = `analytics:engagement:${userId}:${days}`;

    const data = await getOrSetCache(cacheKey, async () => {
      const since = daysAgo(days);

      const postIds = await Post.find({ user: userId, removedAt: null })
        .select("_id")
        .lean()
        .then((ps) => ps.map((p) => p._id));

      const [likeSeries, commentSeries, repostSeries, followerSeries] = await Promise.all([
        Like.aggregate([
          { $match: { post: { $in: postIds }, createdAt: { $gte: since } } },
          { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } }, count: { $sum: 1 } } },
          { $project: { _id: 0, date: "$_id", count: 1 } },
        ]),
        Comment.aggregate([
          { $match: { post: { $in: postIds }, removedAt: null, createdAt: { $gte: since } } },
          { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } }, count: { $sum: 1 } } },
          { $project: { _id: 0, date: "$_id", count: 1 } },
        ]),
        Repost.aggregate([
          { $match: { post: { $in: postIds }, createdAt: { $gte: since } } },
          { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } }, count: { $sum: 1 } } },
          { $project: { _id: 0, date: "$_id", count: 1 } },
        ]),
        Follow.aggregate([
          { $match: { following: userId, createdAt: { $gte: since } } },
          { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } }, count: { $sum: 1 } } },
          { $project: { _id: 0, date: "$_id", count: 1 } },
        ]),
      ]);

      return {
        days,
        likes: fillDailySeries(likeSeries, days),
        comments: fillDailySeries(commentSeries, days),
        reposts: fillDailySeries(repostSeries, days),
        followers: fillDailySeries(followerSeries, days),
      };
    }, TTL.engagement);

    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ---------------------------------------------------------------------------
// GET /analytics/top-posts?limit=5&metric=likes
// ---------------------------------------------------------------------------
export const getTopPosts = async (req, res) => {
  try {
    const userId = req.user._id;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 5, 1), 10);
    const metric = ["likes", "comments", "reposts", "bookmarks"].includes(req.query.metric)
      ? req.query.metric
      : "likes";
    const cacheKey = `analytics:top-posts:${userId}:${metric}:${limit}`;

    const data = await getOrSetCache(cacheKey, async () => {
      const sortField =
        metric === "likes" ? "likesCount"
        : metric === "comments" ? "commentsCount"
        : metric === "reposts" ? "repostsCount"
        : "bookmarksCount";

      let posts;
      if (metric === "bookmarks") {
        const bookmarkCounts = await Bookmark.aggregate([
          { $lookup: { from: "posts", localField: "post", foreignField: "_id", as: "postDoc" } },
          { $unwind: "$postDoc" },
          { $match: { "postDoc.user": userId, "postDoc.removedAt": null } },
          { $group: { _id: "$post", count: { $sum: 1 } } },
          { $sort: { count: -1 } },
          { $limit: limit },
        ]);
        const topIds = bookmarkCounts.map((b) => b._id);
        const countMap = new Map(bookmarkCounts.map((b) => [b._id.toString(), b.count]));
        const rawPosts = await Post.find({ _id: { $in: topIds } })
          .select("_id text images video likesCount commentsCount repostsCount createdAt")
          .lean();
        posts = rawPosts
          .map((p) => ({ ...p, bookmarksCount: countMap.get(p._id.toString()) || 0 }))
          .sort((a, b) => b.bookmarksCount - a.bookmarksCount);
      } else {
        posts = await Post.find({ user: userId, removedAt: null })
          .select("_id text images video likesCount commentsCount repostsCount createdAt")
          .sort({ [sortField]: -1 })
          .limit(limit)
          .lean();
      }

      return { metric, posts };
    }, TTL.topPosts);

    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ---------------------------------------------------------------------------
// GET /analytics/posting-cadence?days=30
// ---------------------------------------------------------------------------
export const getPostingCadence = async (req, res) => {
  try {
    const userId = req.user._id;
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 7), 90);
    const cacheKey = `analytics:cadence:${userId}:${days}`;

    const data = await getOrSetCache(cacheKey, async () => {
      const since = daysAgo(days);
      const posts = await Post.find({ user: userId, removedAt: null, createdAt: { $gte: since } })
        .select("createdAt")
        .lean();

      const byDow = Array.from({ length: 7 }, (_, i) => ({ dow: i, count: 0 }));
      const byHour = Array.from({ length: 24 }, (_, i) => ({ hour: i, count: 0 }));

      for (const p of posts) {
        const d = new Date(p.createdAt);
        byDow[d.getUTCDay()].count += 1;
        byHour[d.getUTCHours()].count += 1;
      }

      return { days, byDow, byHour };
    }, TTL.cadence);

    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ---------------------------------------------------------------------------
// GET /analytics/follower-milestone
// ---------------------------------------------------------------------------
export const getFollowerMilestone = async (req, res) => {
  try {
    const userId = req.user._id;
    const cacheKey = `analytics:milestone:${userId}`;

    const data = await getOrSetCache(cacheKey, async () => {
      const count = await Follow.countDocuments({ following: userId });
      const MILESTONES = [100, 500, 1_000, 5_000, 10_000, 50_000, 100_000, 500_000, 1_000_000];
      const next = MILESTONES.find((m) => m > count) || null;
      return { count, nextMilestone: next };
    }, TTL.milestone);

    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ---------------------------------------------------------------------------
// GET /analytics/top-fans?limit=5
// ---------------------------------------------------------------------------
export const getTopFans = async (req, res) => {
  try {
    const userId = req.user._id;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 5, 1), 10);
    const cacheKey = `analytics:top-fans:${userId}:${limit}`;

    const data = await getOrSetCache(cacheKey, async () => {
      const since = daysAgo(30);
      const postIds = await Post.find({ user: userId, removedAt: null })
        .select("_id")
        .lean()
        .then((ps) => ps.map((p) => p._id));

      if (!postIds.length) return { fans: [] };

      const [likes, comments, reposts] = await Promise.all([
        Like.aggregate([
          { $match: { post: { $in: postIds }, createdAt: { $gte: since } } },
          { $group: { _id: "$user", score: { $sum: 1 } } },
        ]),
        Comment.aggregate([
          { $match: { post: { $in: postIds }, removedAt: null, createdAt: { $gte: since } } },
          { $group: { _id: "$user", score: { $sum: 2 } } },
        ]),
        Repost.aggregate([
          { $match: { post: { $in: postIds }, createdAt: { $gte: since } } },
          { $group: { _id: "$user", score: { $sum: 3 } } },
        ]),
      ]);

      const scoreMap = new Map();
      for (const row of [...likes, ...comments, ...reposts]) {
        const key = row._id.toString();
        if (key === userId.toString()) continue;
        scoreMap.set(key, (scoreMap.get(key) || 0) + row.score);
      }

      const sorted = [...scoreMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
      if (!sorted.length) return { fans: [] };

      const User = (await import("../models/User.js")).default;
      const users = await User.find({ _id: { $in: sorted.map(([id]) => id) } })
        .select("name username profilePic verifications isVerified")
        .lean();
      const userMap = new Map(users.map((u) => [u._id.toString(), u]));

      const fans = sorted
        .map(([id, score]) => ({ user: userMap.get(id), score }))
        .filter((f) => f.user);

      return { fans };
    }, TTL.topFans);

    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ---------------------------------------------------------------------------
// GET /analytics/hashtag-performance?days=30
// ---------------------------------------------------------------------------
export const getHashtagPerformance = async (req, res) => {
  try {
    const userId = req.user._id;
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 7), 90);
    const cacheKey = `analytics:hashtag-perf:${userId}:${days}`;

    const data = await getOrSetCache(cacheKey, async () => {
      const since = daysAgo(days);
      const posts = await Post.find({
        user: userId,
        removedAt: null,
        createdAt: { $gte: since },
        "hashtags.0": { $exists: true },
      })
        .select("hashtags likesCount commentsCount repostsCount")
        .lean();

      const tagMap = new Map();
      for (const p of posts) {
        const eng = (p.likesCount || 0) + (p.commentsCount || 0) + (p.repostsCount || 0);
        for (const tag of p.hashtags || []) {
          const t = tag.toLowerCase();
          const prev = tagMap.get(t) || { total: 0, count: 0 };
          tagMap.set(t, { total: prev.total + eng, count: prev.count + 1 });
        }
      }

      const result = [...tagMap.entries()]
        .map(([tag, { total, count }]) => ({
          tag,
          uses: count,
          avgEngagement: Math.round(total / count),
          totalEngagement: total,
        }))
        .sort((a, b) => b.avgEngagement - a.avgEngagement)
        .slice(0, 15);

      return { days, hashtags: result };
    }, TTL.hashtag);

    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ---------------------------------------------------------------------------
// GET /analytics/best-time-to-post
// ---------------------------------------------------------------------------
export const getBestTimeToPost = async (req, res) => {
  try {
    const userId = req.user._id;
    const cacheKey = `analytics:best-time:${userId}`;

    const data = await getOrSetCache(cacheKey, async () => {
      const posts = await Post.find({ user: userId, removedAt: null })
        .select("createdAt likesCount commentsCount repostsCount")
        .lean();

      if (posts.length < 5) {
        return {
          recommendation: null,
          reason: "Not enough posts yet — we need at least 5 to detect a pattern.",
        };
      }

      const buckets = Array.from({ length: 24 }, () => ({ total: 0, count: 0 }));
      for (const p of posts) {
        const hour = new Date(p.createdAt).getUTCHours();
        const eng = (p.likesCount || 0) + (p.commentsCount || 0) + (p.repostsCount || 0);
        buckets[hour].total += eng;
        buckets[hour].count += 1;
      }

      let bestHour = 0;
      let bestAvg = -1;
      for (let h = 0; h < 24; h++) {
        if (buckets[h].count === 0) continue;
        const avg = buckets[h].total / buckets[h].count;
        if (avg > bestAvg) { bestAvg = avg; bestHour = h; }
      }

      const fmt12 = (h) => {
        const period = h < 12 ? "AM" : "PM";
        const h12 = h % 12 || 12;
        return `${h12}:00 ${period} UTC`;
      };

      return {
        recommendation: {
          hour: bestHour,
          label: fmt12(bestHour),
          avgEngagement: Math.round(bestAvg),
          postsAnalyzed: posts.length,
        },
        reason: `Based on ${posts.length} posts, your audience engages most with content published around ${fmt12(bestHour)}.`,
      };
    }, TTL.bestTime);

    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ---------------------------------------------------------------------------
// GET /analytics/follower-growth?days=30
// ---------------------------------------------------------------------------
export const getFollowerGrowth = async (req, res) => {
  try {
    const userId = req.user._id;
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 7), 90);
    const cacheKey = `analytics:follower-growth:${userId}:${days}`;

    const data = await getOrSetCache(cacheKey, async () => {
      const since = daysAgo(days);

      const series = await Follow.aggregate([
        { $match: { following: userId, createdAt: { $gte: since } } },
        { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } }, count: { $sum: 1 } } },
        { $project: { _id: 0, date: "$_id", count: 1 } },
      ]);

      const totalFollowers = await Follow.countDocuments({ following: userId });

      return {
        days,
        totalFollowers,
        series: fillDailySeries(series, days),
      };
    }, TTL.followerGrowth);

    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ---------------------------------------------------------------------------
// getUnderperformingPost — internal, called by job scheduler only
// Not a user-facing endpoint, no Redis cache needed (job runs on schedule).
// ---------------------------------------------------------------------------
export const getUnderperformingPost = async (userId) => {
  try {
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const recentPosts = await Post.find({
      user: userId,
      removedAt: null,
      scheduledFor: null,
      createdAt: { $gte: since24h },
    })
      .select("_id text images video likesCount commentsCount repostsCount")
      .lean();

    if (!recentPosts.length) return null;

    const allPosts = await Post.find({ user: userId, removedAt: null, scheduledFor: null })
      .select("likesCount commentsCount repostsCount")
      .lean();

    if (allPosts.length < 3) return null;

    const totalEng = allPosts.reduce(
      (s, p) => s + (p.likesCount || 0) + (p.commentsCount || 0) + (p.repostsCount || 0),
      0,
    );
    const avgEng = totalEng / allPosts.length;

    for (const p of recentPosts) {
      const eng = (p.likesCount || 0) + (p.commentsCount || 0) + (p.repostsCount || 0);
      if (eng < avgEng * 0.3) return p;
    }

    return null;
  } catch {
    return null;
  }
};
