import Comment from "../models/Comment.js";
import Post from "../models/Post.js";
import Notification from "../models/Notification.js";
import { io, getReceiverSocketIds } from "../socket/socket.js";

// ADD COMMENT
export const addComment = async (req, res) => {
  try {
    const { text } = req.body;

    const post = await Post.findById(req.params.id);

    if (!post) {
      return res.status(404).json({
        message: "Post not found",
      });
    }

    const comment = await Comment.create({
      post: req.params.id,
      user: req.user._id,
      text,
    });

    post.commentsCount += 1;
    await post.save();

    const populatedComment = await comment.populate("user", "name profilePic");

    // Create comment notification (don't notify yourself)
    if (post.user.toString() !== req.user._id.toString()) {
      try {
        const newNotif = await Notification.create({
          recipient: post.user,
          sender: req.user._id,
          type: "comment",
          post: post._id,
        });

        // Emit "newNotification" to post owner's connected socket IDs
        const populatedNotif = await newNotif.populate(
          "sender",
          "name profilePic",
        );
        const recipientSockets = getReceiverSocketIds(post.user);
        recipientSockets.forEach((socketId) => {
          io.to(socketId).emit("newNotification", populatedNotif);
        });
      } catch (socketError) {
        console.error("Comment notification real-time error:", socketError);
      }
    }

    // Emit "newComment" to the post's specific room
    try {
      io.to(`post_${post._id}`).emit("newComment", {
        postId: post._id,
        comment: populatedComment,
        commentCount: post.commentsCount,
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

// GET COMMENTS
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
    await comment.deleteOne();

    if (post) {
      post.commentsCount = Math.max(0, post.commentsCount - 1);
      await post.save();
    }

    try {
      io.to(`post_${post._id}`).emit("commentDeleted", {
        postId: post._id,
        commentId: comment._id,
        commentCount: post.commentsCount,
      });
    } catch (socketError) {
      console.error("Comment deletion real-time error:", socketError);
    }

    res.status(200).json({
      commentId: comment._id,
      commentCount: post?.commentsCount || 0,
    });
  } catch (error) {
    res.status(500).json({
      message: error.message,
    });
  }
};

export const getComments = async (req, res) => {
  try {
    const comments = await Comment.find({
      post: req.params.id,
    })
      .populate("user", "name profilePic")
      .sort({ createdAt: -1 });

    res.status(200).json(comments);
  } catch (error) {
    res.status(500).json({
      message: error.message,
    });
  }
};
