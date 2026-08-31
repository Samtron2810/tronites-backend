import Comment from "../models/Comment.js";
import Post from "../models/Post.js";
import Notification from "../models/Notification.js";
import User from "../models/User.js";
import { io, emitToUser } from "../socket/socket.js";
import { getOrSetCache, invalidateCache } from "../utils/redis.js";
import { extractMentions } from "../utils/textParser.js";
import { isBlockedEitherWay, getBlockedEitherWayIds } from "../services/blockService.js";
import { canViewPost } from "../services/postVisibilityService.js";
import { hasMuted } from "../services/muteService.js";
import { checkEngagementVelocity } from "../services/engagementVelocityService.js";
import { parseSearchFilters, dateRangeFilter } from "../services/searchService.js";
import {
  getLikedCommentIds,
  createCommentLikeEdge,
  removeCommentLikeEdge,
  removeAllLikesForComment,
  removeAllLikesForComments,
} from "../services/commentLikeService.js";

// ADD COMMENT (top-level, or a reply if parentCommentId is given)
export const addComment = async (req, res) => {
  try {
    const { text, parentCommentId } = req.body;

    const post = await Post.findById(req.params.id);

    if (!post) {
      return res.status(404).json({
        message: "Post not found",
      });
    }

    if (
      post.user.toString() !== req.user._id.toString() &&
      (await isBlockedEitherWay(req.user._id, post.user))
    ) {
      return res.status(403).json({ message: "You can't comment on this post." });
    }

    // Privacy gate — a hidden post (only-me, or followers-only to a
    // non-follower) is indistinguishable from a missing one here, so
    // direct-ID access can't probe for private posts or comment on them.
    if (!(await canViewPost(req.user._id, post))) {
      return res.status(404).json({ message: "Post not found" });
    }

    let parentComment = null;
    if (parentCommentId) {
      parentComment = await Comment.findById(parentCommentId);
      if (!parentComment || parentComment.post.toString() !== post._id.toString()) {
        return res.status(404).json({ message: "Comment not found" });
      }
      // Enforce 1-level nesting: can't reply to a reply.
      if (parentComment.parentComment) {
        return res.status(400).json({
          message: "Cannot reply to a reply — reply to the original comment instead",
        });
      }
    }

    const comment = await Comment.create({
      post: req.params.id,
      user: req.user._id,
      text,
      parentComment: parentComment ? parentComment._id : null,
    });

    post.commentsCount += 1;
    await post.save();

    if (parentComment) {
      parentComment.repliesCount += 1;
      await parentComment.save();
    }

    const populatedComment = await comment.populate("user", "name username profilePic");

    // Invalidate cached comment list(s) for this post
    invalidateCache(`comments:${req.params.id}`);
    if (parentComment) invalidateCache(`replies:${parentComment._id}`);

    // Notify: reply -> parent comment's author; top-level -> post author.
    // Don't double-notify if the same person triggers both (e.g. replying
    // to your own comment on someone else's post still notifies the post
    // owner once via the "comment" path, skipped here since parentComment
    // exists).
    if (parentComment) {
      if (
        parentComment.user.toString() !== req.user._id.toString() &&
        !(await hasMuted(parentComment.user, req.user._id))
      ) {
        try {
          const newNotif = await Notification.create({
            recipient: parentComment.user,
            sender: req.user._id,
            type: "reply",
            post: post._id,
            comment: comment._id,
          });
          const populatedNotif = await newNotif.populate(
            "sender",
            "name username profilePic",
          );
          emitToUser(parentComment.user, "newNotification", populatedNotif);
        } catch (socketError) {
          console.error("Reply notification real-time error:", socketError);
        }
      }
    } else if (
      post.user.toString() !== req.user._id.toString() &&
      !(await hasMuted(post.user, req.user._id))
    ) {
      try {
        const newNotif = await Notification.create({
          recipient: post.user,
          sender: req.user._id,
          type: "comment",
          post: post._id,
          comment: comment._id,
        });
        const populatedNotif = await newNotif.populate(
          "sender",
          "name username profilePic",
        );
        emitToUser(post.user, "newNotification", populatedNotif);
      } catch (socketError) {
        console.error("Comment notification real-time error:", socketError);
      }
    }

    // Notify @mentioned users in the comment/reply text (skip self and
    // whoever was already notified above as the parent/post owner).
    try {
      const mentionedUsernames = extractMentions(text);
      if (mentionedUsernames.length) {
        const alreadyNotified = new Set([
          req.user._id.toString(),
          parentComment ? parentComment.user.toString() : post.user.toString(),
        ]);
        const mentionedUsers = await User.find({
          username: { $in: mentionedUsernames },
          _id: { $nin: [...alreadyNotified] },
        }).select("_id");

        const blockedIds = await getBlockedEitherWayIds(req.user._id);

        await Promise.all(
          mentionedUsers
            .filter((mentionedUser) => !blockedIds.has(mentionedUser._id.toString()))
            .map(async (mentionedUser) => {
              if (await hasMuted(mentionedUser._id, req.user._id)) return;

              const newNotif = await Notification.create({
                recipient: mentionedUser._id,
                sender: req.user._id,
                type: "mention",
                post: post._id,
                comment: comment._id,
              });
              const populatedNotif = await newNotif.populate(
                "sender",
                "name username profilePic",
              );
              emitToUser(mentionedUser._id, "newNotification", populatedNotif);
            }),
        );
      }
    } catch (mentionError) {
      console.error("Comment mention notification error:", mentionError.message);
    }

    // Emit to the post's room — include parentCommentId so clients can
    // append the reply under the right parent instead of the top-level list.
    try {
      io.to(`post_${post._id}`).emit("newComment", {
        postId: post._id,
        comment: populatedComment,
        commentCount: post.commentsCount,
        parentCommentId: parentComment ? parentComment._id : null,
      });
    } catch (socketError) {
      console.error("Comment live count emission error:", socketError);
    }

    res.status(201).json(populatedComment);

    // Fairness fix #2 — fire-and-forget, after the response so it never
    // adds latency to the comment action. Comments only ever ADD
    // engagement here (top-level create, not delete), so every call
    // site is a legitimate candidate to check. See
    // services/engagementVelocityService.js.
    checkEngagementVelocity(post).catch((err) =>
      console.error("Velocity check error:", err),
    );
  } catch (error) {
    res.status(500).json({
      message: error.message,
    });
  }
};

// LIKE/UNLIKE COMMENT (or reply — same Comment model, so this handles both)
export const likeComment = async (req, res) => {
  try {
    const comment = await Comment.findById(req.params.id);
    if (!comment) {
      return res.status(404).json({ message: "Comment not found" });
    }

    const userId = req.user._id;

    if (
      comment.user.toString() !== userId.toString() &&
      (await isBlockedEitherWay(userId, comment.user))
    ) {
      return res.status(403).json({ message: "You can't interact with this comment." });
    }

    // Read-then-act; race safety comes from the unique {user, comment}
    // index on CommentLike, same as post likes (see likePost).
    const removed = await removeCommentLikeEdge(userId, comment._id);
    let liked;

    if (removed) {
      liked = false;
      comment.likesCount = Math.max(0, comment.likesCount - 1);
      await comment.updateOne({ $inc: { likesCount: -1 } });
    } else {
      const created = await createCommentLikeEdge(userId, comment._id);
      liked = true;
      if (created) {
        comment.likesCount += 1;
        await comment.updateOne({ $inc: { likesCount: 1 } });

        if (
          comment.user.toString() !== userId.toString() &&
          !(await hasMuted(comment.user, userId))
        ) {
          try {
            const newNotif = await Notification.create({
              recipient: comment.user,
              sender: userId,
              type: "commentLike",
              post: comment.post,
              comment: comment._id,
            });
            const populatedNotif = await newNotif.populate(
              "sender",
              "name profilePic",
            );
            emitToUser(comment.user, "newNotification", populatedNotif);
          } catch (socketError) {
            console.error("Comment like notification error:", socketError);
          }
        }
      }
    }

    try {
      io.to(`post_${comment.post}`).emit("commentLikeUpdate", {
        postId: comment.post,
        commentId: comment._id,
        likesCount: comment.likesCount,
        userId: userId.toString(),
        liked,
      });
    } catch (socketError) {
      console.error("Comment like emission error:", socketError);
    }

    res.status(200).json({ likes: comment.likesCount, liked });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// DELETE COMMENT (cascades to replies if this is a top-level comment)
export const deleteComment = async (req, res) => {
  try {
    const comment = await Comment.findById(req.params.id);

    if (!comment) {
      return res.status(404).json({ message: "Comment not found" });
    }

    if (comment.user.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: "Not authorized" });
    }

    const post = await Post.findById(comment.post);

    // Cascade: deleting a top-level comment also deletes its replies.
    let deletedCount = 1;
    let deletedReplyIds = [];
    if (!comment.parentComment) {
      const replies = await Comment.find({ parentComment: comment._id }).select("_id");
      deletedReplyIds = replies.map((r) => r._id);
      if (deletedReplyIds.length) {
        await Comment.deleteMany({ _id: { $in: deletedReplyIds } });
        deletedCount += deletedReplyIds.length;
      }
    } else {
      // This is a reply — decrement its parent's repliesCount.
      await Comment.findByIdAndUpdate(comment.parentComment, {
        $inc: { repliesCount: -1 },
      });
    }

    await comment.deleteOne();

    // Clean up like edges — this comment's own, plus every cascaded
    // reply's, so no orphaned CommentLike rows reference a deleted
    // comment.
    await removeAllLikesForComment(comment._id);
    if (deletedReplyIds.length) {
      await removeAllLikesForComments(deletedReplyIds);
    }

    if (post) {
      post.commentsCount = Math.max(0, post.commentsCount - deletedCount);
      await post.save();
    }

    // Invalidate cached comment list for this post (and replies cache if
    // this was a top-level comment with its own reply thread cached)
    invalidateCache(`comments:${comment.post}`);
    invalidateCache(`replies:${comment._id}`);

    try {
      io.to(`post_${post._id}`).emit("commentDeleted", {
        postId: post._id,
        commentId: comment._id,
        parentCommentId: comment.parentComment || null,
        deletedReplyIds,
        commentCount: post.commentsCount,
      });
    } catch (socketError) {
      console.error("Comment deletion real-time error:", socketError);
    }

    res.status(200).json({
      commentId: comment._id,
      deletedReplyIds,
      commentCount: post?.commentsCount || 0,
    });
  } catch (error) {
    res.status(500).json({
      message: error.message,
    });
  }
};

// GET TOP-LEVEL COMMENTS for a post (replies fetched separately, on demand)
export const getComments = async (req, res) => {
  try {
    // Privacy gate — the comments of a hidden post are as private as the
    // post itself. The cached comment list is shared across viewers, so
    // the gate runs before the cache read, keyed on the post, not the
    // cached payload.
    const post = await Post.findById(req.params.id).select("user privacy").lean();
    if (!post || !(await canViewPost(req.user._id, post))) {
      return res.status(404).json({ message: "Post not found" });
    }

    const cacheKey = `comments:${req.params.id}`;

    const comments = await getOrSetCache(
      cacheKey,
      async () => {
        return await Comment.find({
          post: req.params.id,
          parentComment: null,
          removedAt: null, // moderator soft-takedown — see reportService
        })
          .populate("user", "name username profilePic")
          .sort({ createdAt: -1 });
      },
      180,
    );

    // Not baked into the cached query itself — the comment list is
    // cached once per post and shared across every viewer, but which
    // comments to hide (blocklist) and isLiked are both viewer-specific,
    // so both are applied per-request after the shared cache read.
    const blockedIds = await getBlockedEitherWayIds(req.user._id);
    const visible = blockedIds.size
      ? comments.filter((c) => !blockedIds.has(c.user?._id?.toString()))
      : comments;

    const likedCommentIds = await getLikedCommentIds(
      req.user._id,
      visible.map((c) => c._id),
    );
    const withLikeState = visible.map((c) => ({
      ...(c._doc || c),
      isLiked: likedCommentIds.has(c._id.toString()),
    }));

    res.status(200).json(withLikeState);
  } catch (error) {
    res.status(500).json({
      message: error.message,
    });
  }
};

// GET REPLIES for a top-level comment
export const getReplies = async (req, res) => {
  try {
    // Privacy gate — replies belong to a post, so a hidden post hides its
    // replies too. Resolve the post via the parent comment (the param is
    // the comment id, not the post id).
    const parentComment = await Comment.findById(req.params.id)
      .select("post")
      .lean();
    if (!parentComment) {
      return res.status(404).json({ message: "Comment not found" });
    }
    const post = await Post.findById(parentComment.post)
      .select("user privacy")
      .lean();
    if (!(await canViewPost(req.user._id, post))) {
      return res.status(404).json({ message: "Post not found" });
    }

    const cacheKey = `replies:${req.params.id}`;

    const replies = await getOrSetCache(
      cacheKey,
      async () => {
        return await Comment.find({
          parentComment: req.params.id,
          removedAt: null, // moderator soft-takedown — see reportService
        })
          .populate("user", "name username profilePic")
          .sort({ createdAt: 1 });
      },
      180,
    );

    const blockedIds = await getBlockedEitherWayIds(req.user._id);
    const visible = blockedIds.size
      ? replies.filter((r) => !blockedIds.has(r.user?._id?.toString()))
      : replies;

    const likedCommentIds = await getLikedCommentIds(
      req.user._id,
      visible.map((r) => r._id),
    );
    const withLikeState = visible.map((r) => ({
      ...(r._doc || r),
      isLiked: likedCommentIds.has(r._id.toString()),
    }));

    res.status(200).json(withLikeState);
  } catch (error) {
    res.status(500).json({
      message: error.message,
    });
  }
};

// SEARCH COMMENTS — content search over comment bodies, mirrors
// postController.searchPosts's shape/pagination (cursor on textScore,
// public-post-only scope, block-list exclusion) so Explore's "Comments"
// tab can reuse the same client-side pagination code. Only comments on
// PUBLIC posts are searchable (a followers-only/only-me post's comments
// are exactly as hidden from global search as the post itself), and
// `mine=true` narrows further to just the caller's own comments
// regardless of post visibility (searching your own words back should
// always work, even on your own only-me posts).
export const searchComments = async (req, res) => {
  try {
    const query = String(req.query.q || "").trim();
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 30);
    const cursorScore =
      req.query.afterScore !== undefined ? parseFloat(req.query.afterScore) : null;
    const cursorId = req.query.afterId || null;
    const hasCursor = cursorScore !== null && cursorId && !Number.isNaN(cursorScore);
    const mineOnly = req.query.mine === "true";

    const { fromUserId, startDate, endDate, minLikes } = await parseSearchFilters(req.query);
    const hasFilters = fromUserId || startDate || endDate || minLikes !== null;

    if (query.length > 0 && query.length < 2) {
      return res.status(200).json({ comments: [], hasMore: false });
    }
    if (query.length === 0 && !hasFilters && !mineOnly) {
      return res.status(200).json({ comments: [], hasMore: false });
    }

    const blockedIds = await getBlockedEitherWayIds(req.user._id);
    const userFilter = mineOnly
      ? { user: req.user._id }
      : fromUserId
        ? { user: fromUserId }
        : blockedIds.size
          ? { user: { $nin: [...blockedIds] } }
          : {};

    const hasTextQuery = query.length >= 2;
    const filter = {
      ...(hasTextQuery ? { $text: { $search: query } } : {}),
      removedAt: null, // moderator soft-takedown — see reportService
      ...userFilter,
      ...dateRangeFilter(startDate, endDate),
      ...(minLikes !== null ? { likesCount: { $gte: minLikes } } : {}),
    };

    const MAX_SEARCH_CANDIDATES = 500;
    let candidates = await Comment.find(
      filter,
      hasTextQuery ? { score: { $meta: "textScore" } } : {},
    )
      .populate("user", "name username profilePic")
      .populate("post", "user privacy removedAt")
      .sort(hasTextQuery ? { score: { $meta: "textScore" }, _id: -1 } : { createdAt: -1, _id: -1 })
      .limit(MAX_SEARCH_CANDIDATES);

    // Post-visibility gate applied after the DB query (same reasoning
    // as everywhere else canViewPost is used: privacy depends on the
    // follow graph, which isn't cheaply expressible as a single Mongo
    // filter). Skipped entirely for mineOnly since your own comments on
    // your own only-me post should still be findable by you.
    if (!mineOnly) {
      const visible = [];
      for (const c of candidates) {
        if (!c.post || c.post.removedAt) continue;
        if (!(await canViewPost(req.user._id, c.post))) continue;
        visible.push(c);
      }
      candidates = visible;
    } else {
      candidates = candidates.filter((c) => c.post && !c.post.removedAt);
    }

    const filtered = hasCursor
      ? candidates.filter((c) => {
          if (hasTextQuery) {
            const s = c._doc.score;
            if (s < cursorScore) return true;
            if (s === cursorScore) return c._id.toString() < cursorId;
            return false;
          }
          const t = c.createdAt.getTime();
          if (t < cursorScore) return true;
          if (t === cursorScore) return c._id.toString() < cursorId;
          return false;
        })
      : candidates;

    const hasMore = filtered.length > limit;
    const comments = hasMore ? filtered.slice(0, limit) : filtered;

    const likedCommentIds = await getLikedCommentIds(req.user._id, comments.map((c) => c._id));
    const formattedComments = comments.map((c) => ({
      ...c._doc,
      isLiked: likedCommentIds.has(c._id.toString()),
      postId: c.post._id,
    }));

    res.status(200).json({
      comments: formattedComments,
      hasMore,
      nextCursor: hasMore
        ? {
            afterScore: hasTextQuery
              ? comments[comments.length - 1]._doc.score
              : comments[comments.length - 1].createdAt.getTime(),
            afterId: comments[comments.length - 1]._id,
          }
        : null,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
