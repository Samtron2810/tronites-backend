import Post from "../models/Post.js";
import Comment from "../models/Comment.js";
import { toPublicUserDTO } from "../dtos/userDTO.js";
import { isBlockedEitherWay } from "../services/blockService.js";
import { getReactionSummaries } from "../services/reactionService.js";
import { PUBLIC_ONLY_FILTER, PUBLISHED_FILTER } from "../services/postVisibilityService.js";
import { getOrSetCache } from "../utils/redis.js";
import { normalizeImages } from "./postController.js";

// GET /api/public/posts/:id
//
// Deliberately narrower than canViewPost (postVisibilityService.js) — that
// helper's job is "can THIS specific viewer, who may be a follower or
// subscriber, see this post", which is right for the authenticated
// /post/:id route. This endpoint has one rule and it never varies by
// viewer: PUBLIC_ONLY_FILTER, full stop. A logged-in follower gets
// nothing extra here even though they could see a followers-only post via
// the authenticated route — that's the whole point of keeping this a
// separate, viewer-independent, publicly-cacheable response (plan §4.2,
// Phase 4: "Not subscriber-only. Not followers-only.").
export const getPublicPostById = async (req, res) => {
  try {
    const { id } = req.params;

    // Cache is keyed on the post alone (no viewer id) for the same reason
    // as publicUserController's profile cache — this exact payload is
    // correct for every anonymous visitor and every non-follower at once.
    const cacheKey = `public-post:${id}`;

    const cached = await getOrSetCache(
      cacheKey,
      async () => {
        const post = await Post.findOne({
          _id: id,
          removedAt: null,
          ...PUBLISHED_FILTER,
          ...PUBLIC_ONLY_FILTER,
        })
          .populate("user", "name username bio profilePic verifications isVerified openToCollabs createdAt")
          .populate({
            path: "quoteOf",
            populate: {
              path: "user",
              select: "name username profilePic verifications isVerified",
            },
          });

        if (!post) return null;

        // quoteOf must itself be a currently-public post for this public
        // surface — a quote of a since-privatized or removed post still
        // exists as a Post document (quoteOf is a live reference, not a
        // snapshot), but embedding non-public content inside an otherwise
        // public page would defeat PUBLIC_ONLY_FILTER's whole point.
        const quoteOfIsPublic =
          post.quoteOf &&
          !post.quoteOf.removedAt &&
          !post.quoteOf.scheduledFor &&
          (post.quoteOf.privacy === "public" || !post.quoteOf.privacy);

        const idsToCheck = [
          post._id,
          ...(quoteOfIsPublic ? [post.quoteOf._id] : []),
        ];
        const reactionSummaries = await getReactionSummaries("post", idsToCheck);

        // Top-level comments only (no replies — matches the plan's "public
        // comments only, if comments are displayed"; deeper reply threads
        // stay behind the authenticated PostView, same as its own
        // getReplies pagination). Commenter identity goes through the same
        // toPublicUserDTO-safe field list as everywhere else in this file.
        const comments = await Comment.find({
          post: post._id,
          parentComment: null,
          removedAt: null,
        })
          .populate("user", "name username profilePic verifications isVerified")
          .sort({ createdAt: -1 })
          .limit(50);

        return {
          post: {
            ...post._doc,
            user: toPublicUserDTO(post.user),
            images: normalizeImages(post._doc.images),
            isLiked: false,
            isBookmarked: false,
            isReposted: false,
            reactionSummary: reactionSummaries.get(post._id.toString()) || {},
            myReaction: null,
            isQuotePost: Boolean(post.quoteOf),
            quoteOf: quoteOfIsPublic
              ? {
                  ...post.quoteOf._doc,
                  user: toPublicUserDTO(post.quoteOf.user),
                  images: normalizeImages(post.quoteOf._doc.images),
                  isLiked: false,
                  isBookmarked: false,
                  isReposted: false,
                  reactionSummary:
                    reactionSummaries.get(post.quoteOf._id.toString()) || {},
                  myReaction: null,
                }
              : null,
          },
          comments: comments.map((c) => ({
            ...(c._doc || c),
            user: toPublicUserDTO(c.user),
            isLiked: false,
          })),
        };
      },
      60,
    );

    if (!cached) {
      return res.status(404).json({ message: "Post not found" });
    }

    // Block check happens after the shared cache read, same pattern as
    // publicUserController — the cached payload carries no viewer-specific
    // data, so it's safe to gate access to THIS viewer afterward without
    // that block state ever entering the cache. A logged-in visitor who
    // blocked (or was blocked by) the author gets the same 404 the
    // authenticated /post/:id route would give them.
    if (req.user) {
      if (
        req.user._id.toString() !== cached.post.user._id.toString() &&
        (await isBlockedEitherWay(req.user._id, cached.post.user._id))
      ) {
        return res.status(404).json({ message: "Post not found" });
      }
    }

    res.status(200).json(cached);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
