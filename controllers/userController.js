import User from "../models/User.js";
import Post from "../models/Post.js";
import cloudinary from "../utils/cloudinary.js";

export const followUser = async (req, res) => {
  try {
    const userToFollow = await User.findById(req.params.id);

    const currentUser = await User.findById(req.user._id);

    if (!userToFollow) {
      return res.status(404).json({
        message: "User not found",
      });
    }

    // Cannot follow yourself
    if (userToFollow._id.toString() === currentUser._id.toString()) {
      return res.status(400).json({
        message: "You cannot follow yourself",
      });
    }

    const alreadyFollowing = currentUser.following.includes(userToFollow._id);

    if (alreadyFollowing) {
      // UNFOLLOW
      currentUser.following = currentUser.following.filter(
        (id) => id.toString() !== userToFollow._id.toString(),
      );

      userToFollow.followers = userToFollow.followers.filter(
        (id) => id.toString() !== currentUser._id.toString(),
      );
    } else {
      // FOLLOW
      currentUser.following.push(userToFollow._id);

      userToFollow.followers.push(currentUser._id);
    }

    await currentUser.save();

    await userToFollow.save();

    res.status(200).json({
      following: !alreadyFollowing,
    });
  } catch (error) {
    res.status(500).json({
      message: error.message,
    });
  }
};

//PROFILE FUNCTION
export const getUserProfile = async (req, res) => {
  try {
    const user = await User.findById(req.params.id)
      .select("-password")
      .populate("followers", "_id")
      .populate("following", "_id");

    if (!user) {
      return res.status(404).json({
        message: "User not found",
      });
    }

    // User posts
    const posts = await Post.find({
      user: user._id,
    }).sort({ createdAt: -1 });

    // Check if current user follows profile
    const isFollowing = user.followers.some(
      (follower) => follower._id.toString() === req.user._id.toString(),
    );

    res.status(200).json({
      user,
      posts,
      isFollowing,
    });
  } catch (error) {
    res.status(500).json({
      message: error.message,
    });
  }
};

//SEARCH USERS
export const searchUsers = async (req, res) => {
  try {
    const query = req.query.q || "";

    const users = await User.find({
      name: {
        $regex: query,
        $options: "i",
      },

      // exclude current user
      _id: { $ne: req.user._id },
    }).select("name bio profilePic followers");

    res.status(200).json(users);
  } catch (error) {
    res.status(500).json({
      message: error.message,
    });
  }
};

//UPDATE PROFILE IMAGE API
export const updateProfilePicture = async (req, res) => {
  console.log(req.file);

  try {
    const user = await User.findById(req.user._id);

    if (!user) {
      return res.status(404).json({
        message: "User not found",
      });
    }

    const result = await cloudinary.uploader.upload(
      `data:${req.file.mimetype};base64,${req.file.buffer.toString("base64")}`,
      {
        folder: "tronites_profiles",
      },
    );

    user.profilePic = result.secure_url;

    await user.save();

    res.status(200).json({
      profilePic: user.profilePic,
    });
  } catch (error) {
    res.status(500).json({
      message: error.message,
    });
  }
};
