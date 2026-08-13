import Comment from "../models/Comment.js";
import Post from "../models/Post.js";
import Notification from "../models/Notification.js";
import User from "../models/User.js";
import { io, emitToUser } from "../socket/socket.js";
import { getOrSetCache, invalidateCache } from "../utils/redis.js";
import { extractMentions } from "../utils/textParser.js";

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
      if (parentComment.user.toString() !== req.user._id.toString()) {
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
    } else if (post.user.toString() !== req.user._id.toString()) {
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

        await Promise.all(
          mentionedUsers.map(async (mentionedUser) => {
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
  } catch (error) {
    res.status(500).json({
      message: error.message,
    });
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
    const cacheKey = `comments:${req.params.id}`;

    const comments = await getOrSetCache(
      cacheKey,
      async () => {
        return await Comment.find({
          post: req.params.id,
          parentComment: null,
        })
          .populate("user", "name username profilePic")
          .sort({ createdAt: -1 });
      },
      180,
    );

    res.status(200).json(comments);
  } catch (error) {
    res.status(500).json({
      message: error.message,
    });
  }
};

// GET REPLIES for a top-level comment
export const getReplies = async (req, res) => {
  try {
    const cacheKey = `replies:${req.params.id}`;

    const replies = await getOrSetCache(
      cacheKey,
      async () => {
        return await Comment.find({ parentComment: req.params.id })
          .populate("user", "name username profilePic")
          .sort({ createdAt: 1 });
      },
      180,
    );

    res.status(200).json(replies);
  } catch (error) {
    res.status(500).json({
      message: error.message,
    });
  }
};
