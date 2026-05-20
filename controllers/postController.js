import Post from "../models/Post.js";
import User from "../models/User.js";
import cloudinary from "../utils/cloudinary.js"; // ADD THIS

// CREATE POST
export const createPost = async (req, res) => {
  try {
    const { text } = req.body;
    let imageUrl = "";

    console.log("REQ.FILE:", req.file);
    console.log("REQ.BODY:", req.body);

    if (req.file) {
      const b64 = `data:${req.file.mimetype};base64,${req.file.buffer.toString("base64")}`;
      console.log("Uploading to Cloudinary...");
      const result = await cloudinary.uploader.upload(b64, {
        folder: "tronites_posts",
      });
      console.log("Cloudinary result:", result.secure_url);
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
//ANOTHER VERSION OF CREATE POST WITHOUT CLOUDINARY
// export const createPost = async (req, res) => {
//   try {
//     const { text } = req.body;
//     let imageUrl = "";

//     if (req.file) {
//       const result = await cloudinary.uploader.upload(
//         `data:${req.file.mimetype};base64,${req.file.buffer.toString("base64")}`,
//         { folder: "tronites_posts" },
//       );
//       imageUrl = result.secure_url;
//     }

//     const post = await Post.create({
//       user: req.user._id,
//       text,
//       image: imageUrl,
//     });

//     const populatedPost = await post.populate("user", "name profilePic");

//     res.status(201).json(populatedPost);
//   } catch (error) {
//     console.error("CREATE POST ERROR:", error);
//     res.status(500).json({ message: error.message || "Server error" });
//   }
// };

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
    } else {
      // Like
      post.likes.push(userId);
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
