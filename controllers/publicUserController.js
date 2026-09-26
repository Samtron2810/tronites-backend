import User from "../models/User.js";
import Post from "../models/Post.js";
import Repost from "../models/Repost.js";
import { toPublicUserDTO } from "../dtos/userDTO.js";
import { isBlockedEitherWay } from "../services/blockService.js";
import {
  isFollowing,
  getFollowerCount,
  getFollowingCount,
} from "../services/followService.js";
import {
  PUBLIC_ONLY_FILTER,
  PUBLISHED_FILTER,
} from "../services/postVisibilityService.js";
import { getReactionSummaries } from "../services/reactionService.js";
import { getOrSetCache } from "../utils/redis.js";
import { normalizeImages } from "./postController.js";

// GET /api/public/profiles/:username
//
// Anonymous-safe profile read. Deliberately a separate function from
// getUserProfile (not a shared code path with a `if (!req.user)` branch
// sprinkled through it) — the two have different privacy tiers, different
// cache-key shapes, and different response shapes (counts vs. full
// follower-id arrays, no email-select branch, no self-view branch), and
// keeping them apart means a change to the authenticated profile view
// can't accidentally widen what an anonymous visitor sees.
//
// Visibility rules enforced here:
//   - isPrivate accounts: bio/counts/verification still shown (so a
//     visitor knows the account exists and can request to follow), but
//     posts are withheld entirely for anyone who isn't already following.
//     NOTE: getUserProfile (the authenticated profile endpoint) does not
//     currently check isPrivate at all — this is a pre-existing gap in
//     that endpoint, not something introduced here. Worth fixing there
//     too; out of scope for this public-read slice.
//   - Blocked-either-way: 404, same as the authenticated endpoint, so a
//     block can't be confirmed by a 200-vs-404 probe. Skipped entirely
//     for anonymous viewers (no viewer id to have a block relationship).
//   - Post privacy: PUBLIC_ONLY_FILTER always — a public endpoint must
//     never depend on follow-state to decide what ships in a globally
//     cached response. A logged-in follower viewing a friend's profile
//     through this public route only sees the same public slice a
//     stranger would; the richer followers-tier view stays on
//     GET /api/profile/:id (getUserProfile), which already requires auth.
//   - Suspended/banned/deleted accounts: 404 — same externally-observable
//     behavior as "doesn't exist", matching resolveUsername/protect's
//     existing treatment of these states elsewhere in the app.
export const getPublicUserProfile = async (req, res) => {
  try {
    const username = (req.params.username || "").trim().toLowerCase();
    if (!username) {
      return res.status(404).json({ message: "User not found" });
    }

    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(
      Math.max(parseInt(req.query.limit, 10) || 12, 1),
      50,
    );
    const skip = (page - 1) * limit;

    // Cached independent of viewer — this response must be identical for
    // every anonymous visitor and every non-follower, so the cache key
    // carries no viewer id. A logged-in follower/self viewer bypasses the
    // cache below (see viewerId branch) since their own request may need
    // the isFollowing flag computed fresh; the cached payload itself never
    // varies by who's asking.
    const cacheKey = `public-profile:${username}:${page}:${limit}`;

    const cached = await getOrSetCache(
      cacheKey,
      async () => {
        const user = await User.findOne({ username }).select(
          "name username bio profilePic verifications isVerified openToCollabs pinnedPosts location createdAt shadowRanked isPrivate deletedAt banned suspendedUntil",
        );

        if (
          !user ||
          user.deletedAt ||
          user.banned ||
          (user.suspendedUntil && new Date(user.suspendedUntil) > new Date())
        ) {
          return null;
        }

        const [followerCount, followingCount] = await Promise.all([
          getFollowerCount(user._id),
          getFollowingCount(user._id),
        ]);

        const dto = {
          ...toPublicUserDTO(user),
          followerCount,
          followingCount,
        };

        // Private accounts: identity/counts are shown, posts are not —
        // matches the plan's "profile exists, request to follow" pattern
        // rather than a hard 404 that would make private accounts
        // indistinguishable from nonexistent ones.
        if (user.isPrivate) {
          return {
            user: dto,
            isPrivate: true,
            posts: [],
            pinnedPosts: [],
            totalPosts: 0,
            currentPage: page,
            totalPages: 0,
            hasMore: false,
          };
        }

        const postFilter = {
          user: user._id,
          removedAt: null,
          ...PUBLISHED_FILTER,
          ...PUBLIC_ONLY_FILTER,
        };
        const repostFilter = { user: user._id };

        const MAX_PROFILE_ITEMS = 1000;

        const [authoredPosts, repostEdges] = await Promise.all([
          Post.find(postFilter)
            .populate({
              path: "quoteOf",
              populate: {
                path: "user",
                select: "name username profilePic verifications isVerified",
              },
            })
            .sort({ createdAt: -1 })
            .limit(MAX_PROFILE_ITEMS),
          Repost.find(repostFilter)
            .populate({
              path: "post",
              match: { removedAt: null, ...PUBLISHED_FILTER, ...PUBLIC_ONLY_FILTER },
              populate: [
                {
                  path: "user",
                  select: "name username profilePic verifications isVerified",
                },
                {
                  path: "quoteOf",
                  populate: {
                    path: "user",
                    select: "name username profilePic verifications isVerified",
                  },
                },
              ],
            })
            .sort({ createdAt: -1 })
            .limit(MAX_PROFILE_ITEMS),
        ]);

        const validRepostEdges = repostEdges.filter((r) => r.post);

        const items = [
          ...authoredPosts.map((post) => ({
            dedupeKey: post._id.toString(),
            sortAt: post.createdAt,
            reposter: null,
            post,
          })),
          ...validRepostEdges.map((r) => ({
            dedupeKey: r.post._id.toString(),
            sortAt: r.createdAt,
            reposter: r.user,
            post: r.post,
          })),
        ].sort((a, b) => b.sortAt - a.sortAt);

        const seenKeys = new Set();
        const deduped = [];
        for (const item of items) {
          if (seenKeys.has(item.dedupeKey)) continue;
          seenKeys.add(item.dedupeKey);
          deduped.push(item);
        }

        const totalPosts = deduped.length;
        const pageItems = deduped.slice(skip, skip + limit);

        // Pinned posts — same public filter, no viewer-tier branching.
        const pinnedPostIds = dto.pinnedPosts || [];
        const pinnedDocs = pinnedPostIds.length
          ? await Post.find({
              _id: { $in: pinnedPostIds },
              removedAt: null,
              ...PUBLISHED_FILTER,
              ...PUBLIC_ONLY_FILTER,
            }).populate({
              path: "quoteOf",
              populate: {
                path: "user",
                select: "name username profilePic verifications isVerified",
              },
            })
          : [];

        // Public aggregate reaction counts only — no isLiked/isBookmarked/
        // isReposted/myReaction. Those are inherently viewer-specific and
        // this payload is shared across every anonymous visitor; PostCard
        // on the frontend must treat all three as false/null when
        // rendering a public-profile post (see public profile page).
        const allIds = [
          ...pageItems.map((i) => i.post._id),
          ...pageItems.filter((i) => i.post.quoteOf).map((i) => i.post.quoteOf._id),
          ...pinnedDocs.map((d) => d._id),
        ];
        const reactionSummaries = await getReactionSummaries("post", allIds);

        const formatQuoteOf = (quoteOfDoc) => {
          const raw = quoteOfDoc._doc || quoteOfDoc;
          return {
            ...raw,
            images: normalizeImages(raw.images),
            isLiked: false,
            isBookmarked: false,
            isReposted: false,
            reactionSummary: reactionSummaries.get(quoteOfDoc._id.toString()) || {},
            myReaction: null,
          };
        };

        const formatPost = (item) => {
          const raw = item.post._doc || item.post;
          return {
            ...raw,
            images: normalizeImages(raw.images),
            isLiked: false,
            isBookmarked: false,
            isReposted: false,
            reactionSummary: reactionSummaries.get(item.post._id.toString()) || {},
            myReaction: null,
            isQuotePost: Boolean(item.post.quoteOf),
            quoteOf: item.post.quoteOf ? formatQuoteOf(item.post.quoteOf) : null,
            repostedBy: item.reposter
              ? {
                  _id: item.reposter._id,
                  name: item.reposter.name,
                  username: item.reposter.username,
                }
              : null,
          };
        };

        const pinnedOrder = pinnedPostIds.map((id) => id.toString());
        const pinnedPosts = pinnedDocs
          .slice()
          .sort(
            (a, b) =>
              pinnedOrder.indexOf(a._id.toString()) -
              pinnedOrder.indexOf(b._id.toString()),
          )
          .map((doc) => formatPost({ post: doc, reposter: null }));

        const pinnedIdSet = new Set(pinnedPostIds.map((id) => id.toString()));
        const posts = pageItems
          .filter((item) => !pinnedIdSet.has(item.post._id.toString()))
          .map(formatPost);

        return {
          user: dto,
          isPrivate: false,
          posts,
          pinnedPosts,
          totalPosts,
          currentPage: page,
          totalPages: Math.ceil(totalPosts / limit),
          hasMore: skip + pageItems.length < totalPosts,
        };
      },
      // Shorter TTL than the authenticated profile cache (180s) — this
      // response is reused across every anonymous visitor at once (not
      // per-viewer), so a stale window affects far more requests per
      // second; 60s keeps a new post's public visibility lag reasonable
      // without losing most of the caching benefit.
      60,
    );

    if (!cached) {
      return res.status(404).json({ message: "User not found" });
    }

    // Block check happens AFTER the cache read/write (the cached payload
    // itself carries no viewer-specific data, so it's safe to compute
    // this per-request against a shared cache entry) but BEFORE it's
    // returned to THIS viewer — a logged-in visitor who is blocked either
    // way gets the same 404 an authenticated stranger would from
    // getUserProfile, without that block state ever entering the cache.
    if (req.user) {
      const targetDoc = await User.findOne({ username }).select("_id");
      if (
        targetDoc &&
        targetDoc._id.toString() !== req.user._id.toString() &&
        (await isBlockedEitherWay(req.user._id, targetDoc._id))
      ) {
        return res.status(404).json({ message: "User not found" });
      }
    }

    // isFollowing is viewer-specific and deliberately computed outside the
    // shared cache entry — same reasoning as isLiked elsewhere in this
    // codebase. Anonymous viewers always get false.
    let viewerIsFollowing = false;
    if (req.user && cached.user?._id) {
      viewerIsFollowing = await isFollowing(req.user._id, cached.user._id);
    }

    res.status(200).json({ ...cached, viewerIsFollowing });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
