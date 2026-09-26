import Post from "../models/Post.js";
import { toPublicUserDTO } from "../dtos/userDTO.js";
import { getReactionSummaries } from "../services/reactionService.js";
import {
  PUBLIC_ONLY_FILTER,
  PUBLISHED_FILTER,
} from "../services/postVisibilityService.js";
import {
  computeTrendingScore,
  MAX_TRENDING_CANDIDATES,
  TRENDING_WINDOW_DAYS,
} from "./postController.js";
import { getOrSetCache } from "../utils/redis.js";
import { normalizeImages } from "./postController.js";

// GET /api/public/explore
//
// The authenticated getTrendingPosts excludes each viewer's own blocked/
// muted accounts from candidates — a per-viewer filter, which is exactly
// why that endpoint is never cached (block/mute state changes what's even
// eligible, not just how it's flagged). This endpoint has no viewer, so
// there's nothing to exclude on that basis — it's the SAME ranking
// formula (imported from postController, not reimplemented) over the SAME
// public-only candidate pool, minus the one part of the original query
// that only makes sense when there's a specific person asking. That
// absence is also exactly what makes this cacheable: the ranked page is
// identical for every anonymous visitor, so it's safe to share one cache
// entry across all of them (60s TTL — short enough that a viral post
// appears in Explore promptly, long enough to avoid re-scanning
// candidates on every request).
export const getPublicExplore = async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 10, 1), 30);
    const cursorScore =
      req.query.afterScore !== undefined
        ? parseFloat(req.query.afterScore)
        : null;
    const cursorId = req.query.afterId || null;
    const hasCursor =
      cursorScore !== null && cursorId && !Number.isNaN(cursorScore);

    const cacheKey = "public-explore:candidates";

    // Only the ranked candidate list is cached — cursor slicing happens
    // per-request against it, same separation postController's own
    // getTrendingPosts would use if it were cacheable (see comment
    // above for why it isn't).
    const ranked = await getOrSetCache(
      cacheKey,
      async () => {
        const since = new Date(
          Date.now() - TRENDING_WINDOW_DAYS * 24 * 60 * 60 * 1000,
        );

        const candidates = await Post.find({
          removedAt: null,
          ...PUBLISHED_FILTER,
          createdAt: { $gte: since },
          ...PUBLIC_ONLY_FILTER,
          velocityFlagged: { $ne: true },
        })
          .populate("user", "name username profilePic verifications isVerified")
          .populate({
            path: "quoteOf",
            populate: {
              path: "user",
              select: "name username profilePic verifications isVerified",
            },
          })
          .sort({ createdAt: -1 })
          .limit(MAX_TRENDING_CANDIDATES);

        return candidates
          .map((post) => ({ post, score: computeTrendingScore(post) }))
          .sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            return b.post._id.toString().localeCompare(a.post._id.toString());
          });
      },
      60,
    );

    const filtered = hasCursor
      ? ranked.filter(({ post, score }) => {
          if (score < cursorScore) return true;
          if (score === cursorScore) return post._id.toString() < cursorId;
          return false;
        })
      : ranked;

    const hasMore = filtered.length > limit;
    const page = hasMore ? filtered.slice(0, limit) : filtered;

    const postIds = page.map(({ post }) => post._id);
    const quoteOfIds = page
      .filter(({ post }) => post.quoteOf)
      .map(({ post }) => post.quoteOf._id);
    const reactionSummaries = await getReactionSummaries("post", [
      ...postIds,
      ...quoteOfIds,
    ]);

    const formatQuoteOf = (quoteOfDoc) => ({
      ...quoteOfDoc._doc,
      user: toPublicUserDTO(quoteOfDoc.user),
      images: normalizeImages(quoteOfDoc._doc.images),
      isLiked: false,
      isBookmarked: false,
      isReposted: false,
      reactionSummary: reactionSummaries.get(quoteOfDoc._id.toString()) || {},
      myReaction: null,
    });

    const formattedPosts = page.map(({ post }) => ({
      ...post._doc,
      user: toPublicUserDTO(post.user),
      images: normalizeImages(post._doc.images),
      isLiked: false,
      isBookmarked: false,
      isReposted: false,
      isQuotePost: Boolean(post.quoteOf),
      quoteOf: post.quoteOf ? formatQuoteOf(post.quoteOf) : null,
      reactionSummary: reactionSummaries.get(post._id.toString()) || {},
      myReaction: null,
    }));

    res.status(200).json({
      posts: formattedPosts,
      hasMore,
      nextCursor: hasMore
        ? {
            afterScore: page[page.length - 1].score,
            afterId: page[page.length - 1].post._id,
          }
        : null,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
