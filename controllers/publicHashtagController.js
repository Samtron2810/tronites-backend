import Post from "../models/Post.js";
import { toPublicUserDTO } from "../dtos/userDTO.js";
import { getReactionSummaries } from "../services/reactionService.js";
import { PUBLIC_ONLY_FILTER, PUBLISHED_FILTER } from "../services/postVisibilityService.js";
import { getOrSetCache } from "../utils/redis.js";
import { normalizeImages } from "./postController.js";

// GET /api/public/hashtags/:tag
//
// Hashtag browsing is already a global discovery surface on the
// authenticated route (getPostsByHashtag uses PUBLIC_ONLY_FILTER
// unconditionally — no follower/subscriber tier exists for hashtag pages
// at all), so this is a closer mirror of its source than the profile/post
// public endpoints are: same cursor pagination, same filter. What's
// stripped is purely the per-viewer bulk-state calls (isLiked/
// isBookmarked/isReposted/myReaction) and the identity-shaped user
// select, replaced with the public DTO — no block filtering either, since
// this surface was never author-identity-scoped the way a profile page
// is (a stranger already saw the same posts here before Phase 4).
export const getPublicPostsByHashtag = async (req, res) => {
  try {
    const tag = (req.params.tag || "").trim().toLowerCase();
    if (!tag) return res.status(400).json({ message: "Hashtag is required" });

    const limit = Math.min(Math.max(parseInt(req.query.limit) || 10, 1), 30);
    const cursor = req.query.before;

    const cacheKey = `public-hashtag:${tag}:${cursor || "start"}:${limit}`;

    const result = await getOrSetCache(
      cacheKey,
      async () => {
        const filter = {
          hashtags: tag,
          removedAt: null,
          ...PUBLISHED_FILTER,
          ...PUBLIC_ONLY_FILTER,
          ...(cursor ? { _id: { $lt: cursor } } : {}),
        };

        const posts = await Post.find(filter)
          .populate("user", "name username profilePic verifications isVerified")
          .populate({
            path: "quoteOf",
            populate: {
              path: "user",
              select: "name username profilePic verifications isVerified",
            },
          })
          .sort({ _id: -1 })
          .limit(limit + 1);

        const hasMore = posts.length > limit;
        const page = hasMore ? posts.slice(0, limit) : posts;

        // Total is separate from the cursor page — used by the frontend
        // to decide whether this tag is "thin" enough to noindex (plan
        // §5/§8: "Add noindex for empty, thin or low-quality hashtag
        // pages"). Only computed on the first page of a given tag to
        // avoid a count() on every subsequent cursor page; the frontend
        // treats a missing totalCount (page > 1) as "already known
        // non-thin" since it only reaches page 2 by loading more.
        const totalCount = cursor
          ? null
          : await Post.countDocuments({
              hashtags: tag,
              removedAt: null,
              ...PUBLISHED_FILTER,
              ...PUBLIC_ONLY_FILTER,
            });

        return {
          posts: page,
          hasMore,
          nextCursor: hasMore ? page[page.length - 1]._id : null,
          totalCount,
        };
      },
      60,
    );

    const postIds = result.posts.map((p) => p._id);
    const quoteOfIds = result.posts
      .filter((p) => p.quoteOf)
      .map((p) => p.quoteOf._id);
    const reactionSummaries = await getReactionSummaries("post", [
      ...postIds,
      ...quoteOfIds,
    ]);

    const formatQuoteOf = (quoteOfDoc) => {
      const raw = quoteOfDoc._doc || quoteOfDoc;
      return {
        ...raw,
        user: toPublicUserDTO(quoteOfDoc.user),
        images: normalizeImages(raw.images),
        isLiked: false,
        isBookmarked: false,
        isReposted: false,
        reactionSummary: reactionSummaries.get(quoteOfDoc._id.toString()) || {},
        myReaction: null,
      };
    };

    const formattedPosts = result.posts.map((post) => {
      const raw = post._doc || post;
      return {
        ...raw,
        user: toPublicUserDTO(post.user),
        images: normalizeImages(raw.images),
        isLiked: false,
        isBookmarked: false,
        isReposted: false,
        isQuotePost: Boolean(post.quoteOf),
        quoteOf: post.quoteOf ? formatQuoteOf(post.quoteOf) : null,
        reactionSummary: reactionSummaries.get(post._id.toString()) || {},
        myReaction: null,
      };
    });

    res.status(200).json({ ...result, posts: formattedPosts });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
