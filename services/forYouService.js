import Post from "../models/Post.js";
import User from "../models/User.js";
import Follow from "../models/Follow.js";
import { listFollowingIds, listFriendsOfFollowsIds } from "./followService.js";
import { listFollowedHashtags } from "./hashtagFollowService.js";
import { PUBLIC_ONLY_FILTER, feedVisibilityFilter } from "./postVisibilityService.js";

// ── For You ranking ─────────────────────────────────────────────────
// Implements TRONITES_RANKING_FAIRNESS.md exactly: engagement RATE
// (Bayesian-smoothed by followersCount), not raw volume, so a small
// creator whose own audience responds can outrank a big account whose
// audience ignored a post. Reach is a deliberately weak log term (some
// scale credit is correct; it must not dominate). Source weight and
// affinity are viewer-specific and applied on top.
//
// This file intentionally does NOT persist scores — reasoning mirrors
// computeTrendingScore in postController.js: cheap to compute at read
// time from denormalized counters, no write-amplifying background job
// needed to keep a stored score fresh as engagement changes.

export const RANK_PRIOR = 150; // Bayesian pseudo-followers
export const RANK_RATE_CAP = 1.6; // max quality multiplier
const RANK_GRAVITY = 1.8; // reuse Trending's tuned gravity
const RANK_ORIGIN_HOURS = 2;

// Source weights — how much a candidate's origin matters independent of
// its own engagement quality. Followed content is never worth less than
// this floor at the feed-assembly stage (see FOLLOWED_FLOOR_RATIO
// below), so weighting alone can't make For You drift away from being
// "mostly people you follow."
export const SOURCE_WEIGHT = Object.freeze({
  followed: 1.0,
  fof: 0.75,
  interest: 0.6,
  trending: 0.5,
});

// Never let followed-author content drop below this share of a page —
// keeps For You from reading as "an algorithm feed with your follows
// sprinkled in" (see tab-architecture.html's own promise: "Never below
// 50% followed content per page").
const FOLLOWED_FLOOR_RATIO = 0.5;

// Max posts from any single author per page — without this, a handful
// of prolific accounts fill the whole page regardless of score.
const AUTHOR_CAP_PER_PAGE = 2;

// One slot per page reserved for a post from an author the viewer has
// never seen before — the cold-start circuit breaker described in the
// fairness doc (no impressions -> no engagement -> no score -> no
// impressions, forever, without this).
const EXPLORATION_SLOTS_PER_PAGE = 1;

const MAX_CANDIDATES_PER_SOURCE = 250;
const CANDIDATE_WINDOW_DAYS = 14; // wider than Trending's 7d — For You
// is personalized, not a single global hot list, so slightly-older
// posts from people you actually follow still deserve a shot.

export const computeForYouScore = (post, ctx) => {
  const ageHours = (Date.now() - post.createdAt.getTime()) / 3_600_000;

  const rawEngagement = post.likesCount * 2 + post.commentsCount * 3;
  // credibleRatio defaults to 1 until the nightly job populates it —
  // see User.credibleRatio.
  const engagement = rawEngagement * (ctx.credibleRatio ?? 1);

  const rate = engagement / (ctx.authorFollowers + RANK_PRIOR);
  const quality = Math.min(0.5 + rate * 2.5, RANK_RATE_CAP);

  const reach = 1 + Math.log1p(engagement);

  const affinity = 0.4 + 1.6 * (ctx.affinity ?? 0);

  return (
    (reach * quality * affinity * ctx.sourceWeight) /
    Math.pow(ageHours + RANK_ORIGIN_HOURS, RANK_GRAVITY)
  );
};

// Builds the per-viewer candidate pool: followed + friends-of-follows +
// trending (interest-tag sourcing is deferred — see roadmap 2.3 "Follow
// hashtags", which is the natural signal for it and doesn't exist yet).
// Each candidate is tagged with the source it was found through so the
// caller can apply sourceWeight and the author cap/floor.
const gatherCandidates = async (viewerId, { excludeUserIds, since }) => {
  const followingIds = await listFollowingIds(viewerId);
  const followingSet = new Set(followingIds);

  const excludeAuthors = new Set([
    viewerId.toString(),
    ...excludeUserIds,
  ]);

  const followedAuthorIds = followingIds.filter((id) => !excludeAuthors.has(id));

  const fofIds = await listFriendsOfFollowsIds(
    followedAuthorIds,
    [...excludeAuthors, ...followedAuthorIds],
    300,
  );

  // 2.3 — interest source: posts carrying a hashtag the viewer follows,
  // from authors not already covered by followed/fof. This is the
  // signal SOURCE_WEIGHT.interest was defined for but had nothing to
  // read from until HashtagFollow existed (see services/hashtagFollowService.js).
  const followedTags = await listFollowedHashtags(viewerId);

  const baseFilter = {
    removedAt: null,
    createdAt: { $gte: since },
  };

  // Fairness fix #2 — velocity-flagged posts (see
  // services/engagementVelocityService.js) are excluded from the
  // DISCOVERY sources only (interest, trending). followed/fof stay
  // untouched: a flag limits how far a post's suspicious engagement
  // can travel to people who haven't chosen the author, it doesn't
  // hide content from people who already follow them — that would be
  // an unexplained stealth removal from their own chosen feed.
  const discoveryFilter = { ...baseFilter, velocityFlagged: { $ne: true } };

  const [followedPosts, fofPosts, interestPosts, trendingPosts] = await Promise.all([
    followedAuthorIds.length
      ? Post.find({
          ...baseFilter,
          user: { $in: followedAuthorIds },
          ...feedVisibilityFilter(viewerId),
        })
          .populate(
            "user",
            "name username profilePic followersCount credibleRatio verifications isVerified",
          )
          .populate({
            path: "quoteOf",
            populate: { path: "user", select: "name username profilePic verifications isVerified" },
          })
          .sort({ createdAt: -1 })
          .limit(MAX_CANDIDATES_PER_SOURCE)
      : [],
    fofIds.length
      ? Post.find({
          ...baseFilter,
          user: { $in: fofIds },
          ...PUBLIC_ONLY_FILTER, // 2nd-degree — only public posts qualify
        })
          .populate(
            "user",
            "name username profilePic followersCount credibleRatio verifications isVerified",
          )
          .populate({
            path: "quoteOf",
            populate: { path: "user", select: "name username profilePic verifications isVerified" },
          })
          .sort({ createdAt: -1 })
          .limit(MAX_CANDIDATES_PER_SOURCE)
      : [],
    followedTags.length
      ? Post.find({
          ...discoveryFilter,
          hashtags: { $in: followedTags },
          user: { $nin: [...excludeAuthors, ...followedAuthorIds] },
          ...PUBLIC_ONLY_FILTER, // interest is a discovery source — public only
        })
          .populate(
            "user",
            "name username profilePic followersCount credibleRatio verifications isVerified",
          )
          .populate({
            path: "quoteOf",
            populate: { path: "user", select: "name username profilePic verifications isVerified" },
          })
          .sort({ createdAt: -1 })
          .limit(MAX_CANDIDATES_PER_SOURCE)
      : [],
    Post.find({
      ...discoveryFilter,
      user: { $nin: [...excludeAuthors, ...followedAuthorIds] },
      ...PUBLIC_ONLY_FILTER,
    })
      .populate(
            "user",
            "name username profilePic followersCount credibleRatio verifications isVerified",
          )
      .populate({
        path: "quoteOf",
        populate: { path: "user", select: "name username profilePic verifications isVerified" },
      })
      .sort({ likesCount: -1, createdAt: -1 })
      .limit(MAX_CANDIDATES_PER_SOURCE),
  ]);

  const tagged = [
    ...followedPosts.map((post) => ({ post, source: "followed" })),
    ...fofPosts.map((post) => ({ post, source: "fof" })),
    ...interestPosts.map((post) => ({ post, source: "interest" })),
    ...trendingPosts.map((post) => ({ post, source: "trending" })),
  ];

  // Dedup — the same post can surface from more than one source (e.g.
  // trending AND authored by a friend-of-follow); keep the
  // highest-weighted source it appeared under.
  const bySourcePriority = { followed: 3, fof: 2, interest: 1, trending: 0 };
  const byId = new Map();
  for (const item of tagged) {
    const key = item.post._id.toString();
    const existing = byId.get(key);
    if (!existing || bySourcePriority[item.source] > bySourcePriority[existing.source]) {
      byId.set(key, item);
    }
  }

  return { candidates: [...byId.values()], followingSet };
};

// Naive affinity: 1.0 if the viewer follows the author (they opted in),
// else 0. A real past-engagement-weighted affinity table is the roadmap
// 2.1 nightly job's job — this is the honest v1 signal available today
// without one.
const computeAffinity = (post, followingSet) =>
  followingSet.has(post.user._id.toString()) ? 1 : 0.3;

// Applies the author cap and the followed-content floor to a ranked
// list, producing the final page. Walks the ranked list once, admitting
// items in score order but skipping any that would push an author over
// AUTHOR_CAP_PER_PAGE; if the floor isn't met by the time we've walked
// the whole list, backfills with the highest-scoring followed posts
// left over (even if that means bending the author cap — floor wins).
const assemblePage = (ranked, limit) => {
  const authorCounts = new Map();
  const page = [];
  const leftoverFollowed = [];

  for (const item of ranked) {
    if (page.length >= limit) break;
    const authorId = item.post.user._id.toString();
    const count = authorCounts.get(authorId) || 0;
    if (count >= AUTHOR_CAP_PER_PAGE) {
      if (item.source === "followed") leftoverFollowed.push(item);
      continue;
    }
    authorCounts.set(authorId, count + 1);
    page.push(item);
    if (item.source === "followed") {
      // already counted via page
    }
  }

  const followedCount = page.filter((i) => i.source === "followed").length;
  const floor = Math.ceil(limit * FOLLOWED_FLOOR_RATIO);
  if (followedCount < floor && leftoverFollowed.length) {
    // Backfill from the back of the page (lowest scores first) to make
    // room, then insert the best leftover followed posts.
    let need = Math.min(floor - followedCount, leftoverFollowed.length);
    let cursor = page.length - 1;
    while (need > 0 && cursor >= 0) {
      if (page[cursor].source !== "followed") {
        page.splice(cursor, 1, leftoverFollowed.shift());
        need -= 1;
      }
      cursor -= 1;
    }
  }

  return page;
};

// Swaps in one exploration slot: a post from an author not already
// represented in `page`, sampled from recent low-reach candidates. Runs
// after assemblePage so it doesn't get capped/floored away.
const injectExplorationSlot = (page, allCandidates) => {
  if (!allCandidates.length || page.length === 0) return page;
  const pageAuthorIds = new Set(page.map((i) => i.post.user._id.toString()));
  const pool = allCandidates
    .filter((c) => !pageAuthorIds.has(c.post.user._id.toString()))
    .filter((c) => (c.post.likesCount || 0) + (c.post.commentsCount || 0) <= 3)
    .sort((a, b) => b.post.createdAt - a.post.createdAt);

  if (!pool.length) return page;
  const pick = pool[0];
  // Replace the lowest-scoring non-followed slot rather than growing
  // the page past `limit`.
  let replaceAt = -1;
  for (let i = page.length - 1; i >= 0; i -= 1) {
    if (page[i].source !== "followed") {
      replaceAt = i;
      break;
    }
  }
  if (replaceAt === -1) return page; // page is all-followed; leave it alone
  const next = [...page];
  next[replaceAt] = { ...pick, source: "exploration" };
  return next;
};

// Main entry point. Mirrors getFeedPosts/getTrendingPosts's shape
// (posts/hasMore/nextCursor) so the frontend can reuse the same
// pagination pattern. Pagination here is a capped in-memory
// candidate-window ranked-and-sliced approach — same tradeoff Trending
// already makes, for the same reason (a computed score can't drive a DB
// cursor).
export const getForYouCandidates = async ({
  viewerId,
  excludeUserIds,
  excludePostIds,
  limit,
}) => {
  const since = new Date(Date.now() - CANDIDATE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const { candidates, followingSet } = await gatherCandidates(viewerId, {
    excludeUserIds,
    since,
  });

  const excludeSet = new Set(excludePostIds.map((id) => id.toString()));
  const eligible = candidates.filter((c) => !excludeSet.has(c.post._id.toString()));

  const scored = eligible.map((item) => {
    const post = item.post;
    const author = post.user;
    const ctx = {
      authorFollowers: author.followersCount || 0,
      credibleRatio: author.credibleRatio ?? 1,
      affinity: computeAffinity(post, followingSet),
      sourceWeight: SOURCE_WEIGHT[item.source] ?? 0.5,
    };
    return { ...item, score: computeForYouScore(post, ctx) };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.post._id.toString().localeCompare(a.post._id.toString());
  });

  let page = assemblePage(scored, limit);
  page = injectExplorationSlot(page, scored);

  // Final tiebreak sort within the assembled page so exploration/floor
  // backfill doesn't produce a visibly out-of-order feed.
  page.sort((a, b) => b.score - a.score);

  const hasMore = scored.length > page.length;

  return { page, hasMore };
};
