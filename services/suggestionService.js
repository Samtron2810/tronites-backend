import mongoose from "mongoose";
import User from "../models/User.js";
import Follow from "../models/Follow.js";
import Post from "../models/Post.js";
import { listFollowingIds } from "./followService.js";
import { getBlockedEitherWayIds } from "./blockService.js";
import { getMutedIds } from "./muteService.js";

// 2.2 — Real "Who to follow". Replaces the old `searchUsers` empty-query
// branch, which returned arbitrary non-followed users (effectively
// random — see TRONITES_FEATURE_ROADMAP.md 2.2). Ranks candidates on:
//
//   1. Mutual-follow count  — how many accounts the viewer already
//      follows also follow this candidate. The strongest signal:
//      "people you trust already trust them."
//   2. Shared hashtag engagement — candidate has recently posted with a
//      hashtag the viewer has also recently posted with. Reuses
//      Post.hashtags — no new tracking.
//   3. Recency of activity — candidates who haven't posted in a long
//      time are poor suggestions even if otherwise well-connected.
//   4. New-to-Tronites boost — small bonus for accounts created
//      recently, so genuinely new users get a fair shot at their first
//      followers instead of only ever-more-followed accounts compounding.
//
// This is about candidate *people*; candidate *posts* is HashtagFollow
// (2.3, services/hashtagFollowService.js) instead.
//
// ── Hot-path budget ──────────────────────────────────────────────────
// The candidate-level signals (2 and 3 above) read User.lastPostAt and
// User.recentHashtags — both precomputed off the hot path by the
// nightly jobs/computeForYouSignals.js sweep (see that job's
// recomputeSuggestionSignals). This function does NOT scan Post for
// candidates at all; the only Post read left here is the viewer's OWN
// recent hashtags (signal 2's other half), which is bounded to one
// user and cheap regardless of platform size. Only mutual-follow
// counts (signal 1, genuinely per-viewer, can't be precomputed once
// for everyone) still run a live aggregate.
const MUTUAL_WEIGHT = 3;
const SHARED_HASHTAG_WEIGHT = 2;
const RECENCY_WEIGHT = 1.5;
const NEW_ACCOUNT_WEIGHT = 1;

const RECENT_ACTIVITY_WINDOW_DAYS = 14;
const NEW_ACCOUNT_WINDOW_DAYS = 14;
const HASHTAG_SIGNAL_WINDOW_DAYS = 30;
const CANDIDATE_POOL_SIZE = 300;

// Hashtags the viewer has recently posted with — scoped to one user
// (viewer), so this stays cheap at any platform size without needing
// precomputation. The candidate side of this same signal is
// User.recentHashtags, computed nightly (see module comment above).
const getViewerRecentHashtags = async (viewerId) => {
  const since = new Date(Date.now() - HASHTAG_SIGNAL_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const posts = await Post.find({
    user: viewerId,
    createdAt: { $gte: since },
    hashtags: { $exists: true, $ne: [] },
  })
    .select("hashtags")
    .limit(100)
    .lean();
  const tags = new Set();
  for (const p of posts) for (const t of p.hashtags) tags.add(t);
  return tags;
};

// For each candidate, how many of the viewer's own follows also follow
// them. One aggregation over Follow rather than N per-candidate
// queries. Genuinely per-viewer — nothing to precompute here, this is
// as cheap as this signal gets.
const getMutualFollowCounts = async (viewerFollowingIds, candidateIds) => {
  if (!viewerFollowingIds.length || !candidateIds.length) return new Map();
  const rows = await Follow.aggregate([
    {
      $match: {
        follower: { $in: viewerFollowingIds.map((id) => new mongoose.Types.ObjectId(id)) },
        following: { $in: candidateIds },
      },
    },
    { $group: { _id: "$following", count: { $sum: 1 } } },
  ]);
  return new Map(rows.map((r) => [r._id.toString(), r.count]));
};

// Returns ranked, populated candidate user docs (lean) for the empty-
// query "who to follow" surface. Shape matches what searchUsers already
// returns (name/username/bio/profilePic + followers id array) so the
// Explore frontend needs zero changes.
export const getWhoToFollow = async (viewerId, { skip = 0, limit = 10 } = {}) => {
  const [followingIds, blockedIds, mutedIds] = await Promise.all([
    listFollowingIds(viewerId),
    getBlockedEitherWayIds(viewerId),
    getMutedIds(viewerId),
  ]);

  const excludeIds = new Set([
    viewerId.toString(),
    ...followingIds,
    ...blockedIds,
    ...mutedIds,
  ]);

  // Candidate pool: recently-active accounts not already excluded.
  // Reads directly off User.lastPostAt (precomputed nightly) instead of
  // Post.distinct — this is now a single indexed User query regardless
  // of total post volume, where it used to scan up to
  // CANDIDATE_POOL_SIZE * 5 posts per request.
  const since = new Date(Date.now() - RECENT_ACTIVITY_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const activeCandidates = await User.find({
    _id: { $nin: [...excludeIds] },
    lastPostAt: { $gte: since },
  })
    .select("name username bio profilePic createdAt lastPostAt recentHashtags verifications isVerified")
    .sort({ lastPostAt: -1 })
    .limit(CANDIDATE_POOL_SIZE)
    .lean();

  // Cold-start fallback: brand-new platforms won't have 14 days of
  // activity yet (or the nightly job hasn't run once) — fall back to
  // any non-excluded user so the surface never renders empty on a
  // fresh install. Fallback candidates simply score 0 on recency/
  // hashtag signals below, which is honest — we have no activity data
  // for them.
  let candidates = activeCandidates;
  if (candidates.length < limit + skip) {
    const alreadyIn = new Set(candidates.map((u) => u._id.toString()));
    const fallback = await User.find({
      _id: { $nin: [...excludeIds, ...alreadyIn] },
    })
      .select("name username bio profilePic createdAt lastPostAt recentHashtags verifications isVerified")
      .limit(CANDIDATE_POOL_SIZE)
      .lean();
    candidates = [...candidates, ...fallback];
  }
  candidates = candidates.slice(0, CANDIDATE_POOL_SIZE);

  if (!candidates.length) return { users: [], hasMore: false };

  const candidateObjectIds = candidates.map((u) => u._id);

  const [mutualCounts, viewerHashtags] = await Promise.all([
    getMutualFollowCounts(followingIds, candidateObjectIds),
    getViewerRecentHashtags(viewerId),
  ]);

  const now = Date.now();
  const scored = candidates.map((u) => {
    const id = u._id.toString();
    const mutual = mutualCounts.get(id) || 0;

    const candidateTags = u.recentHashtags || [];
    const sharedHashtags = candidateTags.filter((t) => viewerHashtags.has(t)).length;

    // 0..1, decaying linearly to 0 at the edge of the activity window —
    // a candidate who posted today scores full recency credit, one who
    // posted RECENT_ACTIVITY_WINDOW_DAYS ago scores ~0.
    const recencyScore = u.lastPostAt
      ? Math.max(
          0,
          1 - (now - new Date(u.lastPostAt).getTime()) / (RECENT_ACTIVITY_WINDOW_DAYS * 24 * 60 * 60 * 1000),
        )
      : 0;

    const accountAgeDays = (now - new Date(u.createdAt).getTime()) / (24 * 60 * 60 * 1000);
    const newAccountScore = accountAgeDays <= NEW_ACCOUNT_WINDOW_DAYS ? 1 : 0;

    const score =
      mutual * MUTUAL_WEIGHT +
      sharedHashtags * SHARED_HASHTAG_WEIGHT +
      recencyScore * RECENCY_WEIGHT +
      newAccountScore * NEW_ACCOUNT_WEIGHT;

    return { user: u, score, mutual };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.user._id.toString().localeCompare(b.user._id.toString());
  });

  const page = scored.slice(skip, skip + limit);
  const hasMore = scored.length > skip + limit;

  return {
    users: page.map(({ user, mutual }) => ({
      _id: user._id,
      name: user.name,
      username: user.username,
      bio: user.bio,
      profilePic: user.profilePic,
      // Not authoritative follow-state (searchUsers' non-empty branch
      // still returns the real `followers` id array) — the empty-query
      // "who to follow" list only ever shows non-followed candidates by
      // construction, so this is always empty. Kept for shape parity
      // with the frontend's `user.followers.includes(...)` check.
      followers: [],
      // Surfaced so the frontend CAN show "N mutual followers" — purely
      // additive, ignored by any caller that doesn't read it.
      mutualFollowersCount: mutual,
    })),
    hasMore,
  };
};
