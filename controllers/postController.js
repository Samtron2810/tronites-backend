import Post from "../models/Post.js";
import User from "../models/User.js";
import Comment from "../models/Comment.js";
import Notification from "../models/Notification.js";
import cloudinary from "../utils/cloudinary.js"; // ADD THIS

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

    // console.log("REQ.FILE:", req.file);
    // console.log("REQ.BODY:", req.body);

    if (req.file) {
      const b64 = `data:${req.file.mimetype};base64,${req.file.buffer.toString("base64")}`;
      // console.log("Uploading to Cloudinary...");
      const result = await cloudinary.uploader.upload(b64, {
        folder: "tronites_posts",
      });
      // console.log("Cloudinary result:", result.secure_url);
      imageUrl = result.secure_url;
    }

    const post = await Post.create({
      user: req.user._id,
      text,
      image: imageUrl,
    });
    const populatedPost = await post.populate("user", "name profilePic");
    res.status(201).json(populatedPost);
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
    // Current logged in user
    const currentUser = await User.findById(req.user._id);

    // Users allowed in feed
    const feedUsers = [...currentUser.following, currentUser._id];

    // Fetch posts
    const posts = await Post.find({
      user: { $in: feedUsers },
    })
      .populate("user", "name profilePic")
      .sort({ createdAt: -1 });

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

    res.status(200).json(formattedPosts);
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
          await Notification.create({
            recipient: post.user,
            sender: userId,
            type: "like",
            post: post._id,
          });
        }
      }
    }

    await post.save();

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

    res.status(200).json({ message: "Post deleted" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
