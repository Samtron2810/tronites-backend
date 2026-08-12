import Post from "../models/Post.js";
import User from "../models/User.js";
import Comment from "../models/Comment.js";
import Notification from "../models/Notification.js";
import cloudinary from "../utils/cloudinary.js";
import { io, emitToUser, emitToFollowersOf } from "../socket/socket.js";
import { getOrSetCache, invalidateCache } from "../utils/redis.js";
import { uploadImageAndWait } from "../queues/imageUploadQueue.js";
import { listFollowingIds } from "../services/followService.js";

// CREATE POST
export const createPost = async (req, res) => {
  try {
    const { text } = req.body;

    if (!text?.trim() && !req.file) {
      return res.status(400).json({
        message: "Post must contain text or image",
      });
    }

    let imageUrl = "";

    if (req.file) {
      const b64 = `data:${req.file.mimetype};base64,${req.file.buffer.toString("base64")}`;

      // Enqueue the upload instead of calling cloudinary.uploader.upload()
      // directly. Same end result (we still wait for the URL before
      // responding — the client needs it), but the actual HTTP call to
      // Cloudinary runs in the worker, not inline in this handler. Under
      // a burst of simultaneous uploads, requests queue up for a worker
      // slot instead of each one independently blocking on network I/O.
      try {
        const result = await uploadImageAndWait("post-image", {
          base64Data: b64,
          folder: "tronites_posts",
          transformation: [
            {
              width: 1600,
              height: 1600,
              crop: "limit",
              quality: "auto",
              fetch_format: "auto",
            },
          ],
        });
        imageUrl = result.secureUrl;
      } catch (uploadError) {
        return res.status(uploadError.httpStatus || 502).json({
          message: uploadError.message,
          code: uploadError.code || "UPLOAD_FAILED",
        });
      }
    }

    const post = await Post.create({
      user: req.user._id,
      text,
      image: imageUrl,
    });
    const populatedPost = await post.populate("user", "name profilePic");

    // Invalidate feed cache for author's followers
    invalidateCache(`feed:${req.user._id}:*`);
    invalidateCache(`profile-posts:${req.user._id}:*`);

    // Send response FIRST before real-time socket emissions
    res.status(201).json(populatedPost);

    // Real-time post feed update for followers — single room emit instead
    // of looping through every follower individually. Followers join this
    // room automatically on socket connect (see socket/socket.js).
    try {
      emitToFollowersOf(req.user._id, "newPost", populatedPost);
    } catch (socketError) {
      console.error("Real-time feed emission error:", socketError);
    }
  } catch (error) {
    console.error("CREATE POST ERROR NAME:", error.name);
    console.error("CREATE POST ERROR MSG:", error.message);
    console.error("CREATE POST ERROR FULL:", error);
    res.status(500).json({ message: error.message });
  }
};

// GET PERSONALIZED FEED POSTS
export const getFeedPosts = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    const cacheKey = `feed:${req.user._id}:${page}:${limit}`;

    const result = await getOrSetCache(
      cacheKey,
      async () => {
        // Current logged in user
        const followingIds = await listFollowingIds(req.user._id);

        // Users allowed in feed
        const feedUsers = [...followingIds, req.user._id];

        // Fetch posts
        const posts = await Post.find({
          user: { $in: feedUsers },
        })
          .populate("user", "name profilePic")
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit);

        // Total count for pagination
        const totalPosts = await Post.countDocuments({
          user: { $in: feedUsers },
        });

        // Add isLiked field
        const formattedPosts = posts.map((post) => {
          const isLiked = post.likes.some(
            (id) => id.toString() === req.user._id.toString(),
          );

          return {
            ...post._doc,
            isLiked,
          };
        });

        return {
          posts: formattedPosts,
          totalPosts,
          currentPage: page,
          totalPages: Math.ceil(totalPosts / limit),
        };
      },
      // Short TTL by design: likes/comments update live via socket for
      // anyone with a post open, but the feed list itself is cached, so
      // like/comment counts shown here can lag by up to this TTL for
      // users who are not actively viewing the post. A short window
      // keeps that staleness low without invalidating every follower's
      // cache on every like (which doesn't scale for popular posts).
      30,
    );

    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({
      message: error.message,
    });
  }
};

//like functionality
export const likePost = async (req, res) => {
  try {
    const post = await Post.findById(req.params.id);

    if (!post) {
      return res.status(404).json({
        message: "Post not found",
      });
    }

    const userId = req.user._id;

    const alreadyLiked = post.likes.some(
      (id) => id.toString() === userId.toString(),
    );

    if (alreadyLiked) {
      // Unlike
      post.likes = post.likes.filter(
        (id) => id.toString() !== userId.toString(),
      );

      // Remove like notification
      await Notification.deleteOne({
        recipient: post.user,
        sender: userId,
        type: "like",
        post: post._id,
      });
    } else {
      // Like
      post.likes.push(userId);

      // Create like notification (don't notify yourself)
      if (post.user.toString() !== userId.toString()) {
        // Prevent duplicate like notifications
        const existingNotification = await Notification.findOne({
          recipient: post.user,
          sender: userId,
          type: "like",
          post: post._id,
        });

        if (!existingNotification) {
          const newNotif = await Notification.create({
            recipient: post.user,
            sender: userId,
            type: "like",
            post: post._id,
          });

          // Emit "newNotification" to post owner's connected socket IDs
          try {
            const populatedNotif = await newNotif.populate(
              "sender",
              "name profilePic",
            );
            emitToUser(post.user, "newNotification", populatedNotif);
          } catch (socketError) {
            console.error("Like notification real-time error:", socketError);
          }
        }
      }
    }

    await post.save();

    // Invalidate feed caches for both users
    invalidateCache(`feed:${req.user._id}:*`);
    invalidateCache(`feed:${post.user}:*`);

    // Emit "likeUpdate" to the post's specific room
    try {
      io.to(`post_${post._id}`).emit("likeUpdate", {
        postId: post._id,
        likesCount: post.likes.length,
        likes: post.likes,
      });
    } catch (socketError) {
      console.error("Like count emission error:", socketError);
    }

    res.status(200).json({
      likes: post.likes.length,
      liked: !alreadyLiked,
    });
  } catch (error) {
    res.status(500).json({
      message: error.message,
    });
  }
};

// DELETE POST
export const deletePost = async (req, res) => {
  try {
    const post = await Post.findById(req.params.id);

    if (!post) {
      return res.status(404).json({ message: "Post not found" });
    }

    if (post.user.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: "Not authorized" });
    }

    // Delete Cloudinary image safely
    if (post.image) {
      try {
        const publicId = post.image.split("/").slice(-1)[0].split(".")[0];
        await cloudinary.uploader.destroy(`tronites_posts/${publicId}`);
      } catch (err) {
        console.log("Cloudinary delete failed:", err.message);
      }
    }

    // Delete related comments
    await Comment.deleteMany({ post: post._id });

    await post.deleteOne();

    // Invalidate feed cache
    invalidateCache(`feed:${req.user._id}:*`);
    invalidateCache(`profile-posts:${req.user._id}:*`);

    res.status(200).json({ message: "Post deleted" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
