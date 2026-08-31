import Post from "../models/Post.js";

// Fairness fix #2 — real-time velocity circuit breaker.
//
// The nightly credibleRatio sweep (jobs/computeForYouSignals.js) is the
// real anti-gaming mechanism, but it runs once every 24h — a
// coordinated bought-engagement push can sit on trending/interest
// sourcing for most of a day before that catches it, by which point the
// visibility/follows/screenshots have already happened.
//
// This is deliberately NOT a second scoring system. It's a cheap,
// synchronous check called from the like/react/comment hot path
// (postController.js likePost/reactToPost, commentController.js
// addComment) that flags a post the instant its engagement becomes
// statistically implausible for its author's real audience — then gets
// out of the way. The nightly job still makes the actual credibility
// call; this only shortens the window a gamed post can ride visibility
// before that happens, by (a) marking it so forYouService/trending can
// exclude it immediately and (b) letting the nightly sweep prioritize
// its author on its very next run instead of waiting for the full
// engager-aggregation pass to reach them.
//
// ── Tuning ───────────────────────────────────────────────────────────
// IMPLAUSIBLE_MULTIPLE below is a first-guess number, not one tuned
// against real usage — there's no production engagement data yet to
// tune it against (see the reasoning behind VELOCITY_FLAG_LOG below).
// It's env-configurable via VELOCITY_IMPLAUSIBLE_MULTIPLE (see
// .env.example) so tuning later is a config change, not a redeploy.

// A post is only eligible to be flagged inside this window after
// creation — velocity is only a meaningful signal early; a post that's
// been up for a week and slowly accumulated the same engagement count
// is not the same event as one that got it in minutes.
const VELOCITY_WINDOW_MS = 60 * 60 * 1000; // 1 hour

// Below this absolute engagement count, we don't have enough signal to
// call anything implausible — 3 likes on a 0-follower account is just
// someone's friends, not a red flag. Keeps small/legitimate new
// accounts from ever tripping this.
const MIN_ENGAGEMENT_TO_EVALUATE = 15;

// If a post's (likes + comments*2) exceeds the author's followerCount
// by this multiple within VELOCITY_WINDOW_MS, flag it. Deliberately
// generous — organic viral posts among small accounts (a friend group
// sharing something, a small creator's post reaching followers-of-
// followers via a repost) can legitimately exceed follower count by a
// few times over. This threshold is tuned to catch the pattern the
// fairness doc specifically named as implausible (200 likes in minutes
// on a 5-follower account = 40x), not to catch ordinary overperformance.
//
// VELOCITY_IMPLAUSIBLE_MULTIPLE env var overrides the default — see
// .env.example's "Fairness tuning" section. Falls back to 15 if unset
// or unparseable, rather than crashing the flag check.
const parsedMultiple = parseFloat(process.env.VELOCITY_IMPLAUSIBLE_MULTIPLE);
const IMPLAUSIBLE_MULTIPLE =
  Number.isFinite(parsedMultiple) && parsedMultiple > 0 ? parsedMultiple : 15;

// Called after a like/reaction/comment is recorded. Cheap by design:
// one Post read (already have it loaded in the calling controller in
// every current call site) plus, only when the cheap threshold is
// crossed, one more read for the author's followerCount. No writes at
// all on the common case where nothing is flagged.
export const checkEngagementVelocity = async (post) => {
  try {
    if (post.velocityFlagged) return; // already flagged, nothing to do
    if (!post.createdAt) return;

    const ageMs = Date.now() - post.createdAt.getTime();
    if (ageMs > VELOCITY_WINDOW_MS) return; // outside the evaluation window

    const engagementScore = (post.likesCount || 0) + (post.commentsCount || 0) * 2;
    if (engagementScore < MIN_ENGAGEMENT_TO_EVALUATE) return;

    // Only reached past the two cheap checks above — this is the one
    // extra query, and it only runs once the post already looks
    // suspicious on absolute numbers alone.
    const author = await post.populate("user", "followersCount");
    const followerCount = author.user?.followersCount ?? 0;

    if (engagementScore < followerCount * IMPLAUSIBLE_MULTIPLE) return;

    await Post.updateOne(
      { _id: post._id, velocityFlagged: false },
      { $set: { velocityFlagged: true, velocityFlaggedAt: new Date() } },
    );

    // Fix #1 (instrument now, tune later) — logs the exact numbers at
    // the moment of firing, not just "a flag fired". This is the
    // dataset that makes IMPLAUSIBLE_MULTIPLE tunable later: once
    // there's real traffic, these lines let someone look back at the
    // actual (engagementScore, followerCount, multiple-that-fired)
    // distribution and pick a real threshold instead of another guess.
    // Plain console.log to match this codebase's existing logging
    // convention (see roadmap 4.3 — structured logging is a known,
    // separately-tracked gap, not something to introduce piecemeal
    // here).
    console.log(
      `[VELOCITY_FLAG] post=${post._id} author=${author.user?._id ?? "unknown"} ` +
        `engagementScore=${engagementScore} followerCount=${followerCount} ` +
        `actualMultiple=${followerCount > 0 ? (engagementScore / followerCount).toFixed(2) : "inf"} ` +
        `threshold=${IMPLAUSIBLE_MULTIPLE} ageMs=${ageMs}`,
    );
  } catch (error) {
    // Never let a fairness heuristic break the like/comment action it's
    // piggybacking on.
    console.error("[checkEngagementVelocity] failed:", error.message);
  }
};
