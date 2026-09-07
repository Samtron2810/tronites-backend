import Post from "../models/Post.js";
import Like from "../models/Like.js";
import Repost from "../models/Repost.js";
import Comment from "../models/Comment.js";
import Bookmark from "../models/Bookmark.js";
import Follow from "../models/Follow.js";

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
// Summary cards: total posts, total likes, total comments, total reposts,
// total bookmarks, total followers, + their 30d deltas.
// ---------------------------------------------------------------------------
export const getOverview = async (req, res) => {
  try {
    const userId = req.user._id;
    const since30d = daysAgo(30);

    // All post IDs this user has ever authored.
    const postIds = await Post.find({
      user: userId,
      removedAt: null,
    })
      .select("_id createdAt")
      .lean();

    const allPostIds = postIds.map((p) => p._id);
    const recentPostIds = postIds
      .filter((p) => p.createdAt >= since30d)
      .map((p) => p._id);

    const [
      totalLikes,
      totalComments,
      totalReposts,
      totalBookmarks,
      totalFollowers,
      recentLikes,
      recentComments,
      recentReposts,
      recentFollowers,
      recentPosts,
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

    res.status(200).json({
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
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ---------------------------------------------------------------------------
// GET /analytics/engagement?days=30
// Daily time-series of likes+comments+reposts combined (engagement).
// Also returns follower growth per day for the same window.
// ---------------------------------------------------------------------------
export const getEngagementSeries = async (req, res) => {
  try {
    const userId = req.user._id;
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 7), 90);
    const since = daysAgo(days);

    const postIds = await Post.find({ user: userId, removedAt: null })
      .select("_id")
      .lean()
      .then((ps) => ps.map((p) => p._id));

    // Aggregate likes, comments, reposts, bookmarks per day.
    const [likeSeries, commentSeries, repostSeries, followerSeries] =
      await Promise.all([
        Like.aggregate([
          { $match: { post: { $in: postIds }, createdAt: { $gte: since } } },
          {
            $group: {
              _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
              count: { $sum: 1 },
            },
          },
          { $project: { _id: 0, date: "$_id", count: 1 } },
        ]),
        Comment.aggregate([
          {
            $match: {
              post: { $in: postIds },
              removedAt: null,
              createdAt: { $gte: since },
            },
          },
          {
            $group: {
              _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
              count: { $sum: 1 },
            },
          },
          { $project: { _id: 0, date: "$_id", count: 1 } },
        ]),
        Repost.aggregate([
          { $match: { post: { $in: postIds }, createdAt: { $gte: since } } },
          {
            $group: {
              _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
              count: { $sum: 1 },
            },
          },
          { $project: { _id: 0, date: "$_id", count: 1 } },
        ]),
        Follow.aggregate([
          { $match: { following: userId, createdAt: { $gte: since } } },
          {
            $group: {
              _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
              count: { $sum: 1 },
            },
          },
          { $project: { _id: 0, date: "$_id", count: 1 } },
        ]),
      ]);

    res.status(200).json({
      days,
      likes: fillDailySeries(likeSeries, days),
      comments: fillDailySeries(commentSeries, days),
      reposts: fillDailySeries(repostSeries, days),
      followers: fillDailySeries(followerSeries, days),
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ---------------------------------------------------------------------------
// GET /analytics/top-posts?limit=5&metric=likes
// Top performing posts by a chosen metric (likes | comments | reposts | bookmarks).
// ---------------------------------------------------------------------------
export const getTopPosts = async (req, res) => {
  try {
    const userId = req.user._id;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 5, 1), 10);
    const metric = ["likes", "comments", "reposts", "bookmarks"].includes(
      req.query.metric,
    )
      ? req.query.metric
      : "likes";

    const sortField =
      metric === "likes"
        ? "likesCount"
        : metric === "comments"
          ? "commentsCount"
          : metric === "reposts"
            ? "repostsCount"
            : "bookmarksCount";

    // bookmarksCount isn't a denormalized field on Post — compute it live
    // for bookmarks metric; use the stored counter for the others.
    let posts;
    if (metric === "bookmarks") {
      const bookmarkCounts = await Bookmark.aggregate([
        {
          $lookup: {
            from: "posts",
            localField: "post",
            foreignField: "_id",
            as: "postDoc",
          },
        },
        { $unwind: "$postDoc" },
        {
          $match: {
            "postDoc.user": userId,
            "postDoc.removedAt": null,
          },
        },
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

    res.status(200).json({ metric, posts });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ---------------------------------------------------------------------------
// GET /analytics/posting-cadence?days=30
// How many posts per day of week and time of day the creator publishes —
// useful for spotting their natural posting pattern.
// ---------------------------------------------------------------------------
export const getPostingCadence = async (req, res) => {
  try {
    const userId = req.user._id;
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 7), 90);
    const since = daysAgo(days);

    const posts = await Post.find({
      user: userId,
      removedAt: null,
      createdAt: { $gte: since },
    })
      .select("createdAt")
      .lean();

    // day-of-week buckets (0=Sun … 6=Sat)
    const byDow = Array.from({ length: 7 }, (_, i) => ({ dow: i, count: 0 }));
    // hour-of-day buckets (0–23)
    const byHour = Array.from({ length: 24 }, (_, i) => ({ hour: i, count: 0 }));

    for (const p of posts) {
      const d = new Date(p.createdAt);
      byDow[d.getUTCDay()].count += 1;
      byHour[d.getUTCHours()].count += 1;
    }

    res.status(200).json({ days, byDow, byHour });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ---------------------------------------------------------------------------
// GET /analytics/follower-milestone
// Current follower count and nearest milestone (100, 500, 1k, 5k, 10k…).
// ---------------------------------------------------------------------------
export const getFollowerMilestone = async (req, res) => {
  try {
    const userId = req.user._id;
    const count = await Follow.countDocuments({ following: userId });

    const MILESTONES = [100, 500, 1_000, 5_000, 10_000, 50_000, 100_000, 500_000, 1_000_000];
    const next = MILESTONES.find((m) => m > count) || null;

    res.status(200).json({ count, nextMilestone: next });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
