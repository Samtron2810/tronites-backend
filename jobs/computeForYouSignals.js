import User from "../models/User.js";
import Follow from "../models/Follow.js";
import Like from "../models/Like.js";
import Comment from "../models/Comment.js";
import Post from "../models/Post.js";
import {
  bulkCreateImplicitFollows,
  removeImplicitFollows,
} from "../services/hashtagFollowService.js";

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
//
// 3. Recomputes User.lastPostAt / User.recentHashtags — the candidate-
//    side signals for 2.2's "who to follow" ranking (see
//    services/suggestionService.js). Used to live as a per-request Post
//    scan inside getWhoToFollow; moved here so that endpoint's hot path
//    reads two flat, indexed User fields instead of scanning up to
//    CANDIDATE_POOL_SIZE * 5 posts on every empty-query search.
//
// 4. Recomputes implicit HashtagFollow edges (see
//    services/hashtagFollowService.js's implicit-follow helpers) —
//    fairness fix: requiring an EXPLICIT follow before For You's
//    `interest` source (services/forYouService.js) ever activated left
//    that source dark for nearly everyone, since almost no one
//    proactively follows a hashtag unprompted. This derives interest
//    from what users already do (repeated posting/engagement with a
//    tag) instead of requiring an extra deliberate action first.

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

// Suggestion signals (User.lastPostAt / recentHashtags) look back
// further than the 24h engagement window above — matches
// suggestionService.js's own RECENT_ACTIVITY_WINDOW_DAYS/
// HASHTAG_SIGNAL_WINDOW_DAYS, since this job is what populates exactly
// what that service reads.
const SUGGESTION_ACTIVITY_WINDOW_DAYS = 30;
// Cap distinct tags stored per user — mirrors the cap noted on
// User.recentHashtags itself (prevents a hashtag-spamming account from
// bloating the field or the shared-tag-overlap computation).
const MAX_STORED_HASHTAGS = 20;

// Implicit hashtag follows — same 30d lookback as the suggestion
// signals above (one Post scan already covers both; see
// recomputeImplicitHashtagFollows). A user needs at least this many
// authored-posts-with-the-tag, OR this many likes/comments on posts
// carrying the tag, before we infer real interest — low enough to
// actually activate the interest source for moderately active users,
// high enough that a single post or a single like doesn't imply an
// ongoing interest.
const IMPLICIT_FOLLOW_POST_THRESHOLD = 3;
const IMPLICIT_FOLLOW_ENGAGEMENT_THRESHOLD = 5;
// Below this combined signal, a previously-implicit follow is
// considered to have gone stale and is removed — matches the
// lastPostAt stale-clear pattern elsewhere in this job. Lower than the
// creation thresholds above (a follow that's earned shouldn't be lost
// the moment activity dips slightly below the bar that created it —
// only once interest has genuinely dropped off).
const IMPLICIT_FOLLOW_STALE_THRESHOLD = 1;
// Bounds how many (user, tag) pairs a single sweep will touch — a
// safety valve, not expected to bind under normal activity levels.
const MAX_IMPLICIT_FOLLOW_PAIRS = 20000;

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

  // Fairness fix #2 — velocity-flagged authors (see
  // services/engagementVelocityService.js) are unioned in regardless of
  // whether they'd otherwise qualify via the normal 24h engagement
  // window. This is the whole point of the flag: get a flagged author's
  // credibleRatio judged on the very next run, not whenever their
  // engagement volume happens to clear SIGNAL_WINDOW_MS on its own.
  const flaggedPosts = await Post.find({ velocityFlagged: true })
    .select("user")
    .lean();
  const flaggedAuthorIds = flaggedPosts.map((p) => p.user);

  const authorIds = [
    ...new Map(
      [...recentAuthorIds.map((r) => r._id).filter(Boolean), ...flaggedAuthorIds].map(
        (id) => [id.toString(), id],
      ),
    ).values(),
  ];
  if (!authorIds.length) return { updated: 0, flagsCleared: 0 };

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
    // A velocity-flagged author with zero engagers in the 24h sample
    // window is a real (if unlikely) case: their flagged post's
    // engagement happened just outside SIGNAL_WINDOW_MS, or the flag
    // was manually set. Either way, `continue` here would leave their
    // flag stuck forever since the clear-flags update below only
    // touches authorIds that made it into the loop body. Falling
    // through to a 0-ratio instead — no verifiable engagers behind a
    // flagged post is itself a legitimate (low) credibility signal, not
    // a reason to skip judging them.
    const engagers = engagerIds.length
      ? await User.find({ _id: { $in: engagerIds } })
          .select("banned suspendedUntil username createdAt followersCount")
          .lean()
      : [];

    const credibleCount = engagers.filter(isCredibleAccount).length;
    const ratio = engagers.length ? credibleCount / engagers.length : 0;

    await User.updateOne({ _id: authorId }, { $set: { credibleRatio: ratio } });
    updated += 1;
  }

  // Clear the flag on every post whose author was just judged — the
  // flag's whole purpose was "get this author prioritized on the next
  // run", and that run just happened. Leaving it set would permanently
  // suppress the post from trending/interest sourcing even after the
  // real credibleRatio mechanism has had its say.
  let flagsCleared = 0;
  if (flaggedAuthorIds.length) {
    const cleared = await Post.updateMany(
      { velocityFlagged: true, user: { $in: flaggedAuthorIds } },
      { $set: { velocityFlagged: false } },
    );
    flagsCleared = cleared.modifiedCount || 0;
  }

  return { updated, flagsCleared };
};

// Single aggregation over Post: for every author with a non-removed
// post in the last SUGGESTION_ACTIVITY_WINDOW_DAYS, get their most
// recent post timestamp and the (capped, deduped) set of hashtags they
// used in that window. One pass, one write per author — same shape as
// reconcileFollowerCounts above (aggregate once, $set in a loop).
const recomputeSuggestionSignals = async () => {
  const since = new Date(Date.now() - SUGGESTION_ACTIVITY_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const rows = await Post.aggregate([
    { $match: { removedAt: null, createdAt: { $gte: since } } },
    { $sort: { createdAt: -1 } },
    {
      $group: {
        _id: "$user",
        lastPostAt: { $first: "$createdAt" },
        // ifNull guards legacy posts predating the hashtags field —
        // $push would otherwise push `undefined` into the array and
        // break the flat()/Set dedup below.
        hashtags: { $push: { $ifNull: ["$hashtags", []] } },
      },
    },
  ]);

  let updated = 0;
  for (const row of rows) {
    // Flatten + dedupe the per-post hashtag arrays, capped — matches
    // User.recentHashtags's own documented cap.
    const flatTags = [...new Set(row.hashtags.flat())].slice(0, MAX_STORED_HASHTAGS);
    await User.updateOne(
      { _id: row._id },
      { $set: { lastPostAt: row.lastPostAt, recentHashtags: flatTags } },
    );
    updated += 1;
  }

  // Authors with no qualifying post in the window (all posts removed,
  // or their last post fell outside SUGGESTION_ACTIVITY_WINDOW_DAYS)
  // won't appear in `rows` at all — clear their stale signals so a
  // long-inactive account doesn't keep scoring recency credit forever.
  const activeIds = rows.map((r) => r._id);
  const staleCleared = await User.updateMany(
    {
      lastPostAt: { $ne: null },
      _id: { $nin: activeIds },
    },
    { $set: { lastPostAt: null, recentHashtags: [] } },
  );

  return { suggestionsUpdated: updated, suggestionsCleared: staleCleared.modifiedCount || 0 };
};

// Fairness fix #1 — derives implicit HashtagFollow edges from what
// users already do, instead of requiring an explicit follow before For
// You's `interest` source ever has anything to read (see
// services/hashtagFollowService.js's implicit-follow helpers and
// models/HashtagFollow.js's `implicit` field).
//
// Two independent aggregations over the same SUGGESTION_ACTIVITY_WINDOW_DAYS
// window (reusing the constant from recomputeSuggestionSignals — no
// reason for these to drift out of sync):
//   - authored: how many posts a user made with each tag
//   - engaged: how many posts a user liked/commented on that carry each
//     tag (via a $lookup into posts, since Like/Comment don't
//     denormalize the target post's hashtags)
// A (user, tag) pair crossing either threshold gets an implicit follow;
// a previously-implicit pair dropping below the (lower) stale threshold
// on BOTH signals gets removed. Explicit follows are never touched by
// either path.
const recomputeImplicitHashtagFollows = async () => {
  const since = new Date(Date.now() - SUGGESTION_ACTIVITY_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const authoredRows = await Post.aggregate([
    { $match: { removedAt: null, createdAt: { $gte: since }, hashtags: { $exists: true, $ne: [] } } },
    { $unwind: "$hashtags" },
    { $group: { _id: { user: "$user", tag: "$hashtags" }, count: { $sum: 1 } } },
  ]);

  const likeEngagementRows = await Like.aggregate([
    { $match: { createdAt: { $gte: since } } },
    { $lookup: { from: "posts", localField: "post", foreignField: "_id", as: "p" } },
    { $unwind: "$p" },
    { $match: { "p.hashtags.0": { $exists: true } } },
    { $unwind: "$p.hashtags" },
    { $group: { _id: { user: "$user", tag: "$p.hashtags" }, count: { $sum: 1 } } },
  ]);

  const commentEngagementRows = await Comment.aggregate([
    { $match: { createdAt: { $gte: since } } },
    { $lookup: { from: "posts", localField: "post", foreignField: "_id", as: "p" } },
    { $unwind: "$p" },
    { $match: { "p.hashtags.0": { $exists: true } } },
    { $unwind: "$p.hashtags" },
    { $group: { _id: { user: "$user", tag: "$p.hashtags" }, count: { $sum: 1 } } },
  ]);

  // Merge authored + like + comment counts per (user, tag) pair into a
  // single signal map, keeping authored and engagement counts separate
  // (they're compared against different thresholds).
  const signals = new Map(); // key: "userId::tag" -> { userId, tag, authored, engaged }
  const bump = (rows, field) => {
    for (const row of rows) {
      const userId = row._id.user?.toString();
      const tag = row._id.tag;
      if (!userId || !tag) continue;
      const key = `${userId}::${tag}`;
      const existing = signals.get(key) || { userId: row._id.user, tag, authored: 0, engaged: 0 };
      existing[field] += row.count;
      signals.set(key, existing);
    }
  };
  bump(authoredRows, "authored");
  bump(likeEngagementRows, "engaged");
  bump(commentEngagementRows, "engaged");

  const toCreate = [];
  const toRemove = [];
  for (const { userId, tag, authored, engaged } of signals.values()) {
    if (authored >= IMPLICIT_FOLLOW_POST_THRESHOLD || engaged >= IMPLICIT_FOLLOW_ENGAGEMENT_THRESHOLD) {
      toCreate.push({ userId, tag });
    } else if (authored <= IMPLICIT_FOLLOW_STALE_THRESHOLD && engaged <= IMPLICIT_FOLLOW_STALE_THRESHOLD) {
      toRemove.push({ userId, tag });
    }
    if (toCreate.length + toRemove.length >= MAX_IMPLICIT_FOLLOW_PAIRS) break;
  }

  const created = await bulkCreateImplicitFollows(toCreate);
  const removed = await removeImplicitFollows(toRemove);

  return { implicitFollowsCreated: created.inserted, implicitFollowsRemoved: removed.removed };
};

export const computeForYouSignals = async () => {
  try {
    const followerResult = await reconcileFollowerCounts();
    const ratioResult = await recomputeCredibleRatios();
    const suggestionResult = await recomputeSuggestionSignals();
    const implicitFollowResult = await recomputeImplicitHashtagFollows();
    console.log(
      `[computeForYouSignals] followersCount: ${followerResult.corrected} corrected, ${followerResult.zeroedOut} zeroed. ` +
        `credibleRatio: ${ratioResult.updated} author(s) updated, ${ratioResult.flagsCleared} velocity flag(s) cleared. ` +
        `suggestion signals: ${suggestionResult.suggestionsUpdated} author(s) updated, ${suggestionResult.suggestionsCleared} cleared. ` +
        `implicit hashtag follows: ${implicitFollowResult.implicitFollowsCreated} created, ${implicitFollowResult.implicitFollowsRemoved} removed.`,
    );
    return { ...followerResult, ...ratioResult, ...suggestionResult, ...implicitFollowResult };
  } catch (error) {
    // A background sweep must never crash the process.
    console.error("[computeForYouSignals] failed:", error.message);
    return null;
  }
};
