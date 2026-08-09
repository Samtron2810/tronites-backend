import User from "../models/User.js";
import Post from "../models/Post.js";
import Notification from "../models/Notification.js";
import { emitToUser, joinFollowersRoom, leaveFollowersRoom } from "../socket/socket.js";
import { getOrSetCache, invalidateCache } from "../utils/redis.js";
import { uploadImageAndWait } from "../queues/imageUploadQueue.js";
import {
  isFollowing,
  listFollowers,
  listFollowing,
  listFollowingIds,
  createFollowEdge,
  removeFollowEdge,
} from "../services/followService.js";

export const followUser = async (req, res) => {
  try {
    const userToFollow = await User.findById(req.params.id);
    const currentUser = req.user;

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

    const alreadyFollowing = await isFollowing(currentUser._id, userToFollow._id);

    if (alreadyFollowing) {
      // UNFOLLOW
      await removeFollowEdge(currentUser._id, userToFollow._id);

      // Leave the followers-of-X room immediately so this socket stops
      // getting X's new-post events without needing a reconnect.
      leaveFollowersRoom(currentUser._id.toString(), userToFollow._id);

      // Remove follow notification
      await Notification.deleteOne({
        recipient: userToFollow._id,
        sender: currentUser._id,
        type: "follow",
      });
    } else {
      // FOLLOW
      const created = await createFollowEdge(currentUser._id, userToFollow._id);

      if (created) {
        // Join the followers-of-X room immediately so this socket starts
        // getting X's new-post events without needing a reconnect.
        joinFollowersRoom(currentUser._id.toString(), userToFollow._id);

        const existingNotification = await Notification.findOne({
          recipient: userToFollow._id,
          sender: currentUser._id,
          type: "follow",
        });

        if (!existingNotification) {
          const newNotif = await Notification.create({
            recipient: userToFollow._id,
            sender: currentUser._id,
            type: "follow",
          });

          // Emit "newNotification" to followed user's connected socket IDs
          try {
            const populatedNotif = await newNotif.populate(
              "sender",
              "name profilePic",
            );
            emitToUser(userToFollow._id, "newNotification", populatedNotif);
          } catch (socketError) {
            console.error("Follow notification real-time error:", socketError);
          }
        }
      }
    }

    // Invalidate profile caches for both users
    invalidateCache(`profile:${req.user._id}:*`);
    invalidateCache(`profile:${userToFollow._id}:*`);

    // Invalidate followers/following caches for both users
    invalidateCache(`followers:${req.user._id}`);
    invalidateCache(`followers:${userToFollow._id}`);
    invalidateCache(`following:${req.user._id}`);
    invalidateCache(`following:${userToFollow._id}`);

    // Invalidate current user's search cache so results reflect new follow state
    invalidateCache(`searchUsers:${req.user._id}:*`);

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
    const cacheKey = `profile:${req.params.id}:${req.user._id}`;

    const result = await getOrSetCache(
      cacheKey,
      async () => {
        const user = await User.findById(req.params.id).select("-password");

        if (!user) {
          return null;
        }

        // User posts
        const posts = await Post.find({
          user: user._id,
        }).sort({ createdAt: -1 });

        // Followers/following now come from the Follow collection instead
        // of embedded arrays — fetched in parallel since they're
        // independent queries.
        const [followers, following, following_current] = await Promise.all([
          listFollowers(user._id, "_id"),
          listFollowing(user._id, "_id"),
          isFollowing(req.user._id, user._id),
        ]);

        return {
          user: {
            ...user.toObject(),
            followers,
            following,
          },
          posts,
          isFollowing: following_current,
        };
      },
      180,
    );

    if (!result) {
      return res.status(404).json({
        message: "User not found",
      });
    }

    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({
      message: error.message,
    });
  }
};

//SEARCH USERS
export const searchUsers = async (req, res) => {
  try {
    const query = String(req.query.q || "").trim();
    const cacheKey = `searchUsers:${req.user._id}:${query}`;

    const users = await getOrSetCache(
      cacheKey,
      async () => {
        let matchedUsers;

        if (query.length === 0) {
          // Get the list of users the current user is already following
          const followingIds = await listFollowingIds(req.user._id);

          // Exclude both the current user and users they already follow
          matchedUsers = await User.find({
            _id: { $nin: [req.user._id, ...followingIds] },
          })
            .select("name bio profilePic")
            .limit(5)
            .lean();
        } else if (query.length < 2) {
          return [];
        } else {
          matchedUsers = await User.find({
            name: {
              $regex: query,
              $options: "i",
            },

            // exclude current user
            _id: { $ne: req.user._id },
          })
            .select("name bio profilePic")
            .limit(10)
            .lean();
        }

        // Attach each result's follower id list — the frontend uses
        // `user.followers.includes(currentUser._id)` to render follow
        // state on the Explore grid.
        return await Promise.all(
          matchedUsers.map(async (u) => {
            const followers = await listFollowers(u._id, "_id");
            return {
              ...u,
              followers: followers.map((f) => f._id.toString()),
            };
          }),
        );
      },
      180,
    );

    res.status(200).json(users);
  } catch (error) {
    res.status(500).json({
      message: error.message,
    });
  }
};

//UPDATE PROFILE IMAGE API
export const updateProfilePicture = async (req, res) => {
  // console.log(req.file);

  try {
    const user = await User.findById(req.user._id);

    if (!user) {
      return res.status(404).json({
        message: "User not found",
      });
    }

    const b64 = `data:${req.file.mimetype};base64,${req.file.buffer.toString("base64")}`;

    // Same reasoning as post images: enqueue instead of calling
    // Cloudinary directly, so this request doesn't block the event loop
    // for the full upload duration.
    let result;
    try {
      result = await uploadImageAndWait("profile-image", {
        base64Data: b64,
        folder: "tronites_profiles",
      });
    } catch (uploadError) {
      return res.status(uploadError.httpStatus || 502).json({
        message: uploadError.message,
        code: uploadError.code || "UPLOAD_FAILED",
      });
    }

    user.profilePic = result.secureUrl;

    await user.save();

    // Invalidate profile cache
    invalidateCache(`profile:${req.user._id}:*`);

    res.status(200).json({
      profilePic: user.profilePic,
    });
  } catch (error) {
    console.error("PROFILE PIC ERROR:", error);
    res.status(500).json({ message: error.message || "Server error" });
  }
};

//UPDATE BIO API
export const updateBio = async (req, res) => {
  try {
    const bio = req.body.bio?.trim() || "";

    const user = await User.findByIdAndUpdate(
      req.user._id,
      { bio },
      { new: true },
    ).select("-password");

    // Invalidate profile cache
    invalidateCache(`profile:${req.user._id}:*`);

    res.status(200).json({ bio: user.bio });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

//GET FOLLOWERS API
export const getFollowers = async (req, res) => {
  try {
    const cacheKey = `followers:${req.params.id}`;

    const followers = await getOrSetCache(
      cacheKey,
      async () => {
        const userExists = await User.exists({ _id: req.params.id });
        if (!userExists) {
          return null;
        }

        return await listFollowers(req.params.id, "name profilePic bio");
      },
      180,
    );

    if (followers === null) {
      return res.status(404).json({
        message: "User not found",
      });
    }

    res.status(200).json(followers);
  } catch (error) {
    res.status(500).json({
      message: error.message,
    });
  }
};

//GET FOLLOWING API
export const getFollowing = async (req, res) => {
  try {
    const cacheKey = `following:${req.params.id}`;

    const following = await getOrSetCache(
      cacheKey,
      async () => {
        const userExists = await User.exists({ _id: req.params.id });
        if (!userExists) {
          return null;
        }

        return await listFollowing(req.params.id, "name profilePic bio");
      },
      180,
    );

    if (following === null) {
      return res.status(404).json({
        message: "User not found",
      });
    }

    res.status(200).json(following);
  } catch (error) {
    res.status(500).json({
      message: error.message,
    });
  }
};
