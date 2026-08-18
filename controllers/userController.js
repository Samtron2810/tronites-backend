import User from "../models/User.js";
import Post from "../models/Post.js";
import Notification from "../models/Notification.js";
import Block from "../models/Block.js";
import { emitToUser, joinFollowersRoom, leaveFollowersRoom } from "../socket/socket.js";
import { getOrSetCache, invalidateCache } from "../utils/redis.js";
import { uploadImageAndWait } from "../queues/imageUploadQueue.js";
import { hasBlocked, isBlockedEitherWay } from "../services/blockService.js";
import { autoPromoteIfMutual } from "../services/conversationService.js";
import { toPublicUserDTO, toPrivateSelfDTO } from "../dtos/userDTO.js";
import {
  isFollowing,
  listFollowers,
  listFollowing,
  listFollowingIds,
  createFollowEdge,
  removeFollowEdge,
  getFollowerCount,
  getFollowingCount,
} from "../services/followService.js";

// CHECK USERNAME AVAILABILITY (live check while typing)
export const checkUsername = async (req, res) => {
  try {
    const raw = (req.query.username || "").trim().toLowerCase();

    if (!raw) {
      return res.status(400).json({ message: "Username is required" });
    }
    if (!/^[a-z0-9_]{3,20}$/.test(raw)) {
      return res.status(200).json({
        available: false,
        reason: "3-20 chars: lowercase letters, numbers, underscores only",
      });
    }

    const existing = await User.findOne({ username: raw }).select("_id");
    res.status(200).json({ available: !existing });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// SET USERNAME (one-time onboarding step post-signup, or later change)
export const setUsername = async (req, res) => {
  try {
    const { username } = req.body;

    const existing = await User.findOne({ username });
    if (existing && existing._id.toString() !== req.user._id.toString()) {
      return res.status(409).json({ message: "Username is already taken" });
    }

    const user = await User.findByIdAndUpdate(
      req.user._id,
      { username },
      { new: true, runValidators: true },
    ).select("name username bio profilePic email");

    res.status(200).json({ user: toPrivateSelfDTO(user) });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ message: "Username is already taken" });
    }
    res.status(500).json({ message: error.message });
  }
};

// BLOCK STATUS — has the current user blocked this profile, or vice versa?
export const getBlockStatus = async (req, res) => {
  try {
    const targetId = req.params.id;
    const [iBlockedThem, theyBlockedMe] = await Promise.all([
      hasBlocked(req.user._id, targetId),
      hasBlocked(targetId, req.user._id),
    ]);
    res.status(200).json({ iBlockedThem, theyBlockedMe });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// BLOCK a user — full block semantics: severs the follow edge in both
// directions (a blocked user should not keep showing up in your feed
// via a follow that predates the block, and you shouldn't show up in
// theirs), stops messaging (enforced in messageController via
// isBlockedEitherWay), and hides posts/profile per the feed/profile
// filtering added in postController/userController below.
export const blockUser = async (req, res) => {
  try {
    const targetId = req.params.id;
    if (targetId === req.user._id.toString()) {
      return res.status(400).json({ message: "You can't block yourself" });
    }
    const target = await User.findById(targetId).select("_id");
    if (!target) return res.status(404).json({ message: "User not found" });

    await Block.create({ blocker: req.user._id, blocked: targetId }).catch((err) => {
      if (err.code !== 11000) throw err; // already blocked — no-op
    });

    // Sever any follow edge either direction existed. Blocking someone
    // you follow, or who follows you, should immediately stop their
    // posts from reaching your feed and vice versa — a stale follow
    // edge left in place would otherwise keep feeding blocked-user
    // content through the follow-based feed query.
    const [removedMineToThem, removedTheirsToMine] = await Promise.all([
      removeFollowEdge(req.user._id, targetId),
      removeFollowEdge(targetId, req.user._id),
    ]);

    if (removedMineToThem) {
      leaveFollowersRoom(req.user._id.toString(), targetId);
    }
    if (removedTheirsToMine) {
      leaveFollowersRoom(targetId, req.user._id.toString());
    }

    // Drop any pending/existing follow notifications between the two —
    // no point notifying either side of a relationship that no longer
    // exists.
    await Notification.deleteMany({
      type: "follow",
      $or: [
        { recipient: req.user._id, sender: targetId },
        { recipient: targetId, sender: req.user._id },
      ],
    });

    invalidateCache(`feed:${req.user._id}:*`);
    invalidateCache(`feed:${targetId}:*`);
    invalidateCache(`profile:${req.user._id}:*`);
    invalidateCache(`profile:${targetId}:*`);
    invalidateCache(`followers:${req.user._id}:*`);
    invalidateCache(`followers:${targetId}:*`);
    invalidateCache(`following:${req.user._id}:*`);
    invalidateCache(`following:${targetId}:*`);

    res.status(200).json({ blocked: true });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// UNBLOCK a user — lifts the messaging/feed/profile restriction. Does
// NOT restore the follow edge that blocking severed; if either side
// wants to follow again post-unblock, that's a deliberate new action,
// not something that should silently reappear.
export const unblockUser = async (req, res) => {
  try {
    const targetId = req.params.id;
    await Block.deleteOne({ blocker: req.user._id, blocked: targetId });

    invalidateCache(`feed:${req.user._id}:*`);
    invalidateCache(`feed:${targetId}:*`);
    invalidateCache(`profile:${req.user._id}:*`);
    invalidateCache(`profile:${targetId}:*`);

    res.status(200).json({ blocked: false });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

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

    // A block always wins over a new follow — unfollowing (the
    // `alreadyFollowing` branch below) stays allowed either way since
    // that only removes a relationship, it never creates one.
    if (!alreadyFollowing && (await isBlockedEitherWay(currentUser._id, userToFollow._id))) {
      return res.status(403).json({ message: "You can't follow this user." });
    }

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

        // If this follow makes it mutual, any pending message request
        // between them auto-promotes to an open conversation.
        try {
          await autoPromoteIfMutual(currentUser._id, userToFollow._id);
        } catch (promoteError) {
          console.error("Auto-promote conversation error:", promoteError.message);
        }
      }
    }

    // Invalidate profile caches for both users
    invalidateCache(`profile:${req.user._id}:*`);
    invalidateCache(`profile:${userToFollow._id}:*`);

    // Invalidate followers/following caches for both users
    invalidateCache(`followers:${req.user._id}:*`);
    invalidateCache(`followers:${userToFollow._id}:*`);
    invalidateCache(`following:${req.user._id}:*`);
    invalidateCache(`following:${userToFollow._id}:*`);

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

// RESOLVE USERNAME -> USER ID (for @mention links and /u/:username routes)
export const resolveUsername = async (req, res) => {
  try {
    const username = (req.params.username || "").trim().toLowerCase();
    const user = await User.findOne({ username }).select("_id username name profilePic");
    if (!user) return res.status(404).json({ message: "User not found" });
    res.status(200).json({ user });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

//PROFILE FUNCTION
export const getUserProfile = async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(
      Math.max(parseInt(req.query.limit, 10) || 12, 1),
      50,
    );
    const skip = (page - 1) * limit;

    const isSelf = req.params.id === req.user._id.toString();

    // A block hides the profile from both directions — check before
    // touching the cache/DB at all so a blocked viewer can't even
    // confirm the account still exists via a 200 vs 404 distinction.
    // Self-view always allowed (isSelf implies no block check needed —
    // a user can never have blocked themselves, see blockUser's
    // self-block guard).
    if (!isSelf && (await isBlockedEitherWay(req.user._id, req.params.id))) {
      return res.status(404).json({ message: "User not found" });
    }

    // User + followers/following cached separately from posts, since posts
    // now vary by page/limit and shouldn't blow up the cache key space.
    // Cache key already varies per (target id, viewer id), so it's also
    // safe to vary which fields get fetched/returned per viewer below —
    // a self-view and someone-else's-view of the same target can never
    // collide on this key.
    const userCacheKey = `profile:${req.params.id}:${req.user._id}`;

    const userResult = await getOrSetCache(
      userCacheKey,
      async () => {
        // Only fetch email from Mongo at all when this is a self-view —
        // defense in depth on top of the DTO below: if a future code
        // change accidentally serialized the raw doc instead of going
        // through the DTO, a public-view query that never fetched email
        // in the first place still can't leak it.
        const selectFields = isSelf
          ? "name username bio profilePic email"
          : "name username bio profilePic";
        const user = await User.findById(req.params.id).select(selectFields);

        if (!user) {
          return null;
        }

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
            ...(isSelf ? toPrivateSelfDTO(user) : toPublicUserDTO(user)),
            followers,
            following,
          },
          isFollowing: following_current,
        };
      },
      180,
    );

    if (!userResult) {
      return res.status(404).json({
        message: "User not found",
      });
    }

    const postsCacheKey = `profile-posts:${req.params.id}:${page}:${limit}`;

    const postsResult = await getOrSetCache(
      postsCacheKey,
      async () => {
        const [posts, totalPosts] = await Promise.all([
          Post.find({ user: req.params.id })
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit),
          Post.countDocuments({ user: req.params.id }),
        ]);

        return {
          posts,
          totalPosts,
          currentPage: page,
          totalPages: Math.ceil(totalPosts / limit),
          hasMore: skip + posts.length < totalPosts,
        };
      },
      180,
    );

    res.status(200).json({
      ...userResult,
      ...postsResult,
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
    const query = String(req.query.q || "").trim();
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(
      Math.max(parseInt(req.query.limit, 10) || 10, 1),
      30,
    );
    const skip = (page - 1) * limit;

    const cacheKey = `searchUsers:${req.user._id}:${query}:${page}:${limit}`;

    const result = await getOrSetCache(
      cacheKey,
      async () => {
        let matchedUsers;
        let totalUsers;

        if (query.length === 0) {
          // Get the list of users the current user is already following
          const followingIds = await listFollowingIds(req.user._id);
          const excludeIds = [req.user._id, ...followingIds];

          [matchedUsers, totalUsers] = await Promise.all([
            User.find({ _id: { $nin: excludeIds } })
              .select("name username bio profilePic")
              .skip(skip)
              .limit(limit)
              .lean(),
            User.countDocuments({ _id: { $nin: excludeIds } }),
          ]);
        } else if (query.length < 2) {
          return { users: [], hasMore: false };
        } else {
          const filter = {
            $or: [
              { name: { $regex: query, $options: "i" } },
              { username: { $regex: query, $options: "i" } },
            ],
            // exclude current user
            _id: { $ne: req.user._id },
          };

          [matchedUsers, totalUsers] = await Promise.all([
            User.find(filter)
              .select("name username bio profilePic")
              .skip(skip)
              .limit(limit)
              .lean(),
            User.countDocuments(filter),
          ]);
        }

        // Attach each result's follower id list — the frontend uses
        // `user.followers.includes(currentUser._id)` to render follow
        // state on the Explore grid.
        const users = await Promise.all(
          matchedUsers.map(async (u) => {
            const followers = await listFollowers(u._id, "_id");
            return {
              ...u,
              followers: followers.map((f) => f._id.toString()),
            };
          }),
        );

        return { users, hasMore: skip + users.length < totalUsers };
      },
      180,
    );

    res.status(200).json(result);
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
    ).select("bio");

    // Invalidate profile cache
    invalidateCache(`profile:${req.user._id}:*`);

    res.status(200).json({ bio: user.bio });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// UPDATE PRESENCE VISIBILITY — who can see this user's online status.
export const updatePresenceVisibility = async (req, res) => {
  try {
    const { presenceVisibility } = req.body;

    const user = await User.findByIdAndUpdate(
      req.user._id,
      { presenceVisibility },
      { new: true },
    ).select("presenceVisibility");

    res.status(200).json({ presenceVisibility: user.presenceVisibility });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

//GET FOLLOWERS API
export const getFollowers = async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(
      Math.max(parseInt(req.query.limit, 10) || 20, 1),
      50,
    );
    const skip = (page - 1) * limit;

    const cacheKey = `followers:${req.params.id}:${page}:${limit}`;

    const result = await getOrSetCache(
      cacheKey,
      async () => {
        const userExists = await User.exists({ _id: req.params.id });
        if (!userExists) {
          return null;
        }

        const [followers, totalFollowers] = await Promise.all([
          listFollowers(req.params.id, "name profilePic bio", { skip, limit }),
          getFollowerCount(req.params.id),
        ]);

        return {
          followers,
          hasMore: skip + followers.length < totalFollowers,
        };
      },
      180,
    );

    if (result === null) {
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

//GET FOLLOWING API
export const getFollowing = async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(
      Math.max(parseInt(req.query.limit, 10) || 20, 1),
      50,
    );
    const skip = (page - 1) * limit;

    const cacheKey = `following:${req.params.id}:${page}:${limit}`;

    const result = await getOrSetCache(
      cacheKey,
      async () => {
        const userExists = await User.exists({ _id: req.params.id });
        if (!userExists) {
          return null;
        }

        const [following, totalFollowing] = await Promise.all([
          listFollowing(req.params.id, "name profilePic bio", { skip, limit }),
          getFollowingCount(req.params.id),
        ]);

        return {
          following,
          hasMore: skip + following.length < totalFollowing,
        };
      },
      180,
    );

    if (result === null) {
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
