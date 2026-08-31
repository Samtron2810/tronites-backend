import User from "../models/User.js";
import Follow from "../models/Follow.js";
import Like from "../models/Like.js";
import Comment from "../models/Comment.js";

// For You maintenance sweep — two jobs in one, same boot-then-interval
// cadence as jobs/flagRepeatOffenders.js (see index.js wiring).
//
// 1. Reconciles User.followersCount against the real Follow edge count.
//    Same rationale as roadmap 4.7: the $inc-at-the-edge writes in
//    followService.js are best-effort, so a crash mid-request can drift
//    the counter. This is the safety net, not the primary write path.
//
// 2. Recomputes User.credibleRatio: the fraction of a user's most
//    recent likers/commenters who are "credible" accounts (age > 7d,
//    has a username, not banned/suspended, has at least one follower).
//    Deliberately off the hot path — see TRONITES_RANKING_FAIRNESS.md:
//    "credibleRatio should be computed in the nightly affinity job, not
//    on the hot path". Stubbed at 1.0 for any user this sweep hasn't
//    reached yet (User.credibleRatio's schema default).

const CREDIBLE_ACCOUNT_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// Only recompute credibleRatio for authors who received engagement
// recently — an account nobody interacted with this week doesn't need
// its ratio touched, and skipping it keeps the sweep bounded regardless
// of total user count.
const SIGNAL_WINDOW_MS = 24 * 60 * 60 * 1000;
// Cap how many recent engagers we sample per author — a viral post's
// full like list isn't needed to estimate credibility, a sample is
// enough and keeps this job cheap.
const ENGAGER_SAMPLE_SIZE = 200;

// NOTE: the createdAt-range scans below (Like/Comment) are backed by
// each model's bare `{ createdAt: -1 }` index — see models/Like.js and
// models/Comment.js. Without it this sweep collection-scans both
// collections every run.

const isCredibleAccount = (user) => {
  if (!user) return false;
  if (user.banned) return false;
  if (user.suspendedUntil && user.suspendedUntil > new Date()) return false;
  if (!user.username) return false;
  if (Date.now() - user.createdAt.getTime() < CREDIBLE_ACCOUNT_AGE_MS) return false;
  if (!user.followersCount || user.followersCount < 1) return false;
  return true;
};

const reconcileFollowerCounts = async () => {
  const counts = await Follow.aggregate([
    { $group: { _id: "$following", count: { $sum: 1 } } },
  ]);
  let corrected = 0;
  for (const { _id, count } of counts) {
    const res = await User.updateOne(
      { _id, followersCount: { $ne: count } },
      { $set: { followersCount: count } },
    );
    if (res.modifiedCount > 0) corrected += 1;
  }
  // Users with zero real followers but a stale nonzero counter (their
  // last edge was removed) won't appear in the aggregate above at all.
  const zeroed = await User.updateMany(
    { followersCount: { $gt: 0 }, _id: { $nin: counts.map((c) => c._id) } },
    { $set: { followersCount: 0 } },
  );
  return { corrected, zeroedOut: zeroed.modifiedCount || 0 };
};

const recomputeCredibleRatios = async () => {
  const since = new Date(Date.now() - SIGNAL_WINDOW_MS);

  const recentAuthorIds = await Like.aggregate([
    { $match: { createdAt: { $gte: since } } },
    { $lookup: { from: "posts", localField: "post", foreignField: "_id", as: "p" } },
    { $unwind: "$p" },
    { $group: { _id: "$p.user" } },
  ]);
  const authorIds = recentAuthorIds.map((r) => r._id).filter(Boolean);
  if (!authorIds.length) return { updated: 0 };

  let updated = 0;
  for (const authorId of authorIds) {
    const likes = await Like.find({ createdAt: { $gte: since } })
      .populate({ path: "post", match: { user: authorId }, select: "user" })
      .select("user post")
      .limit(ENGAGER_SAMPLE_SIZE)
      .lean();
    const relevantLikerIds = likes.filter((l) => l.post).map((l) => l.user);

    const comments = await Comment.find({
      createdAt: { $gte: since },
    })
      .populate({ path: "post", match: { user: authorId }, select: "user" })
      .select("user post")
      .limit(ENGAGER_SAMPLE_SIZE)
      .lean();
    const relevantCommenterIds = comments.filter((c) => c.post).map((c) => c.user);

    const engagerIds = [...new Set([...relevantLikerIds, ...relevantCommenterIds].map((id) => id.toString()))];
    if (!engagerIds.length) continue;

    const engagers = await User.find({ _id: { $in: engagerIds } })
      .select("banned suspendedUntil username createdAt followersCount")
      .lean();

    const credibleCount = engagers.filter(isCredibleAccount).length;
    const ratio = engagers.length ? credibleCount / engagers.length : 1;

    await User.updateOne({ _id: authorId }, { $set: { credibleRatio: ratio } });
    updated += 1;
  }
  return { updated };
};

export const computeForYouSignals = async () => {
  try {
    const followerResult = await reconcileFollowerCounts();
    const ratioResult = await recomputeCredibleRatios();
    console.log(
      `[computeForYouSignals] followersCount: ${followerResult.corrected} corrected, ${followerResult.zeroedOut} zeroed. credibleRatio: ${ratioResult.updated} author(s) updated.`,
    );
    return { ...followerResult, ...ratioResult };
  } catch (error) {
    // A background sweep must never crash the process.
    console.error("[computeForYouSignals] failed:", error.message);
    return null;
  }
};
