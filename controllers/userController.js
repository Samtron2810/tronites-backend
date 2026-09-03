import User from "../models/User.js";
import Post from "../models/Post.js";
import Repost from "../models/Repost.js";
import Notification from "../models/Notification.js";
import Block from "../models/Block.js";
import bcrypt from "bcryptjs";
import { emitToUser, joinFollowersRoom, leaveFollowersRoom } from "../socket/socket.js";
import { getOrSetCache, invalidateCache, invalidateFeedCache } from "../utils/redis.js";
import { uploadImageAndWait } from "../queues/imageUploadQueue.js";
import { hasBlocked, isBlockedEitherWay } from "../services/blockService.js";
import { getWhoToFollow } from "../services/suggestionService.js";
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
import { getLikedPostIds } from "../services/likeService.js";
import { getBookmarkedPostIds } from "../services/bookmarkService.js";
import { getRepostedPostIds } from "../services/repostService.js";
import {
  getReactionSummaries,
  getUserReactions,
} from "../services/reactionService.js";
import {
  PUBLIC_ONLY_FILTER,
  FOLLOWERS_VISIBLE_FILTER,
} from "../services/postVisibilityService.js";
import { softDeleteAccount } from "../services/accountDeletionService.js";
import { buildUserDataExport } from "../services/dataExportService.js";
import { clearAuthCookies } from "../utils/tokens.js";

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
const USERNAME_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export const setUsername = async (req, res) => {
  try {
    const { username } = req.body;

    const existing = await User.findOne({ username });
    if (existing && existing._id.toString() !== req.user._id.toString()) {
      return res.status(409).json({ message: "Username is already taken" });
    }

    // Load current state to distinguish "first-ever selection"
    // (post-signup onboarding, no cooldown) from "changing an existing
    // username" (cooldown applies). req.user from `protect` may be
    // stale/partial depending on the auth middleware's select — refetch
    // explicitly rather than trust it here.
    const current = await User.findById(req.user._id).select(
      "username usernameChangedAt",
    );

    if (current.username) {
      const lastChanged = current.usernameChangedAt;
      if (lastChanged) {
        const elapsed = Date.now() - new Date(lastChanged).getTime();
        if (elapsed < USERNAME_COOLDOWN_MS) {
          const nextAllowed = new Date(
            new Date(lastChanged).getTime() + USERNAME_COOLDOWN_MS,
          );
          return res.status(429).json({
            message: "You can only change your username once every 30 days",
            nextAllowedAt: nextAllowed,
          });
        }
      }

      if (username === current.username) {
        return res.status(400).json({
          message: "That's already your username",
        });
      }
    }

    const user = await User.findByIdAndUpdate(
      req.user._id,
      {
        username,
        // Only stamp the cooldown clock on an actual change, not the
        // initial onboarding selection — otherwise a brand-new user
        // would be locked out of changing their mind for 30 days right
        // after signup.
        ...(current.username ? { usernameChangedAt: new Date() } : {}),
      },
      { returnDocument: "after", runValidators: true },
    ).select("name username bio profilePic email usernameChangedAt nameChangedAt role permissions presenceVisibility");

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

    invalidateFeedCache(req.user._id);
    invalidateFeedCache(targetId);
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

    invalidateFeedCache(req.user._id);
    invalidateFeedCache(targetId);
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
    const user = await User.findOne({ username }).select("_id username name profilePic verifications isVerified");
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
          ? "name username bio profilePic email verifications isVerified"
          : "name username bio profilePic verifications isVerified";
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

    // Which tier can the viewer see? Self -> everything; a follower ->
    // public + followers-only; anyone else -> public only. This drives
    // both the posts query filter and the cache key below. isFollowing
    // is index-backed and cheap (see followService), so it's safe to
    // compute on every request rather than sharing a tier with the
    // userResult cache.
    const viewerIsFollowing = isSelf
      ? false
      : await isFollowing(req.user._id, req.params.id);

    const postsVisibilityFilter = isSelf
      ? {}
      : viewerIsFollowing
        ? FOLLOWERS_VISIBLE_FILTER
        : PUBLIC_ONLY_FILTER;

    // Cache key must vary by the viewer's relationship tier — a
    // stranger, a follower, and the owner herself each see a different
    // subset of the same profile (public / public+followers / all), so
    // sharing one entry across them would leak private posts. Keeping
    // the `profile-posts:` + ownerId prefix means the existing
    // `profile-posts:<owner>:*` invalidations (post create/edit/delete,
    // moderation takedown, account deletion) still clear every tier.
    const postsCacheKey = `profile-posts:${req.params.id}:${
      isSelf ? "self" : viewerIsFollowing ? "follows" : "other"
    }:${page}:${limit}`;

    // This cache entry is shared across every viewer in the SAME tier
    // (keyed by profile owner + tier + page/limit), so it must never
    // store viewer-specific data. isLiked depends on who's asking, so
    // it's computed fresh per-request below, after the shared cache
    // read — not inside the cached fetchFn, where it would leak one
    // viewer's like-state into another viewer's cached response.
    //
    // Two sources are merged into one profile timeline, same idea as
    // getFeedPosts's merge (see that function's comment for the full
    // reasoning) but offset-paginated instead of cursor-based, to match
    // this endpoint's existing page/limit contract:
    //   1. Posts authored by this profile owner — ordinary posts AND
    //      quote posts, both live in the Post collection (tiered by
    //      postsVisibilityFilter — a follower sees followers-only
    //      posts too, a stranger only sees public ones; a quote is
    //      always public by construction, see createQuotePost).
    //   2. Repost edges BY this profile owner — always a thin pointer
    //      at a post (ordinary or quote), never gated by
    //      postsVisibilityFilter since a repost can only ever point at
    //      a PUBLIC post (see isRepostable): every viewer who can see
    //      this profile at all can see its reposts.
    const postsResult = await getOrSetCache(
      postsCacheKey,
      async () => {
        const postFilter = {
          user: req.params.id,
          removedAt: null,
          ...postsVisibilityFilter,
        };
        const repostFilter = { user: req.params.id };

        // Both sources are fetched in full (up to a defensive cap) and
        // merged/deduped/paginated in memory below, rather than each
        // being independently skip()/limit()'d — a true offset into
        // "post #47 across BOTH collections combined" can't be pushed
        // down as two independent single-collection skips, since which
        // collection contributes which rows at that offset depends on
        // their interleaved chronological order. MAX_PROFILE_ITEMS
        // bounds worst-case work for prolific accounts, same reasoning
        // as MAX_TRENDING_CANDIDATES/MAX_SEARCH_CANDIDATES elsewhere in
        // this file — a profile with more than this many combined
        // posts+reposts will have its oldest items silently excluded
        // from pagination rather than the query blowing up.
        const MAX_PROFILE_ITEMS = 1000;

        const [authoredPosts, repostEdges] = await Promise.all([
          Post.find(postFilter)
            .populate({
              path: "quoteOf",
              populate: { path: "user", select: "name username profilePic verifications isVerified" },
            })
            .sort({ createdAt: -1 })
            .limit(MAX_PROFILE_ITEMS),
          Repost.find(repostFilter)
            .populate({
              path: "post",
              match: { removedAt: null, ...PUBLIC_ONLY_FILTER },
              populate: [
                { path: "user", select: "name username profilePic verifications isVerified" },
                {
                  path: "quoteOf",
                  populate: { path: "user", select: "name username profilePic verifications isVerified" },
                },
              ],
            })
            .sort({ createdAt: -1 })
            .limit(MAX_PROFILE_ITEMS),
        ]);

        // Drop edges whose target didn't survive the populate match
        // (removed by a moderator, or privatized since the repost was
        // made) — same reasoning as getFeedPosts.
        const validRepostEdges = repostEdges.filter((r) => r.post);

        const items = [
          ...authoredPosts.map((post) => ({
            dedupeKey: post._id.toString(),
            sortAt: post.createdAt,
            reposter: null,
            post,
          })),
          ...validRepostEdges.map((r) => ({
            dedupeKey: r.post._id.toString(),
            sortAt: r.createdAt,
            reposter: r.user,
            post: r.post,
          })),
        ].sort((a, b) => b.sortAt - a.sortAt);

        // Dedup: a repost of your OWN post/quote would otherwise show
        // twice (once as the authored post, once as the repost edge) —
        // collapse to the more recent occurrence, same rule as
        // getFeedPosts.
        const seenKeys = new Set();
        const deduped = [];
        for (const item of items) {
          if (seenKeys.has(item.dedupeKey)) continue;
          seenKeys.add(item.dedupeKey);
          deduped.push(item);
        }

        const totalPosts = deduped.length;
        const page_ = deduped.slice(skip, skip + limit);

        return {
          items: page_,
          totalPosts,
          currentPage: page,
          totalPages: Math.ceil(totalPosts / limit),
          hasMore: skip + page_.length < totalPosts,
        };
      },
      180,
    );

    // Bulk-check like/bookmark/repost state for every post shown AND
    // every embedded original (quoteOf) — each is an independent Post
    // document with its own state now.
    const postIds = postsResult.items.map((item) => item.post._id);
    const quoteOfIds = postsResult.items
      .filter((item) => item.post.quoteOf)
      .map((item) => item.post.quoteOf._id);
    const allIds = [...postIds, ...quoteOfIds];
    const [
      likedPostIds,
      bookmarkedPostIds,
      repostedPostIds,
      reactionSummaries,
      myReactions,
    ] = await Promise.all([
      getLikedPostIds(req.user._id, allIds),
      getBookmarkedPostIds(req.user._id, allIds),
      getRepostedPostIds(req.user._id, allIds),
      getReactionSummaries("post", allIds),
      getUserReactions(req.user._id, "post", allIds),
    ]);

    const formatQuoteOf = (quoteOfDoc) => ({
      ...(quoteOfDoc._doc || quoteOfDoc),
      isLiked: likedPostIds.has(quoteOfDoc._id.toString()),
      isBookmarked: bookmarkedPostIds.has(quoteOfDoc._id.toString()),
      isReposted: repostedPostIds.has(quoteOfDoc._id.toString()),
      reactionSummary: reactionSummaries.get(quoteOfDoc._id.toString()) || {},
      myReaction: myReactions.get(quoteOfDoc._id.toString()) || null,
    });

    const postsWithLikeState = postsResult.items.map((item) => ({
      ...(item.post._doc || item.post),
      isLiked: likedPostIds.has(item.post._id.toString()),
      isBookmarked: bookmarkedPostIds.has(item.post._id.toString()),
      isReposted: repostedPostIds.has(item.post._id.toString()),
      // Same reaction fields the feed endpoints send (see postController)
      // — PostCard's reaction bar needs them; omitting them leaves
      // reactionSummary undefined on profile posts.
      reactionSummary: reactionSummaries.get(item.post._id.toString()) || {},
      myReaction: myReactions.get(item.post._id.toString()) || null,
      isQuotePost: Boolean(item.post.quoteOf),
      quoteOf: item.post.quoteOf ? formatQuoteOf(item.post.quoteOf) : null,
      // On a profile page, "repostedBy" is redundant with "whose
      // profile am I on" for a repost — the header ("🔁 Reposted")
      // doesn't need to name the owner again the way the follow-feed's
      // cross-author header does. Still set it (rather than always
      // null) so PostCard's existing repost-header rendering works
      // unmodified; the frontend can choose to suppress the name on
      // this surface if desired.
      repostedBy: item.reposter
        ? {
            _id: item.reposter._id,
            name: item.reposter.name,
            username: item.reposter.username,
          }
        : null,
    }));

    res.status(200).json({
      ...userResult,
      ...postsResult,
      posts: postsWithLikeState,
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
          // 2.2 — real "Who to follow" ranking (mutual follows, shared
          // hashtag activity, recency, new-account boost) instead of
          // the old arbitrary $nin scan. See services/suggestionService.js
          // for the full scoring breakdown. This branch already returns
          // the final page/hasMore shape, so it skips the shared
          // matchedUsers -> users hydration below entirely.
          return getWhoToFollow(req.user._id, { skip, limit });
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
              .select("name username bio profilePic verifications isVerified")
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
    // for the full upload duration. transformation is passed here (unlike
    // the previous version) since avatars render small (~24-96px)
    // everywhere in the app -- no reason to store/serve a raw,
    // full-resolution upload. c_fill + g_face crops to a square framed on
    // the detected face rather than a naive center-crop; g_face falls
    // back to center automatically if no face is detected.
    let result;
    try {
      result = await uploadImageAndWait("profile-image", {
        base64Data: b64,
        folder: "tronites_profiles",
        transformation: "w_400,h_400,c_fill,g_face,q_auto,f_auto",
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
const NAME_COOLDOWN_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

// UPDATE NAME — firstName/lastName, rate-limited separately from
// username. Shorter cooldown (3d vs username's 30d) because this guards
// against rapid identity-flip abuse (renaming to dodge recognition right
// after being reported/blocked), not link/mention stability — nothing
// else keys off `name` the way it does off `username`.
export const updateName = async (req, res) => {
  try {
    const { firstName, lastName } = req.body;

    const user = await User.findById(req.user._id);

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    if (user.nameChangedAt) {
      const elapsed = Date.now() - new Date(user.nameChangedAt).getTime();
      if (elapsed < NAME_COOLDOWN_MS) {
        const nextAllowed = new Date(
          new Date(user.nameChangedAt).getTime() + NAME_COOLDOWN_MS,
        );
        return res.status(429).json({
          message: "You can only change your name once every 3 days",
          nextAllowedAt: nextAllowed,
        });
      }
    }

    // Use the document's .save() (with runValidators on) instead of
    // findByIdAndUpdate so the schema's pre("validate") hook re-derives
    // `name` from firstName/lastName. findByIdAndUpdate skips document
    // hooks — leaving `name` stale at its old value and returning it to
    // the client, so the UI would show the old name right after saving.
    user.firstName = firstName;
    user.lastName = lastName;
    user.nameChangedAt = new Date();
    await user.save();

    // `name` is denormalized into search index and any place that reads
    // a cached profile — same invalidation as updateBio below.
    invalidateCache(`profile:${req.user._id}:*`);

    res.status(200).json({ user: toPrivateSelfDTO(user) });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const updateBio = async (req, res) => {
  try {
    const bio = req.body.bio?.trim() || "";

    const user = await User.findByIdAndUpdate(
      req.user._id,
      { bio },
      { returnDocument: "after" },
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
      { returnDocument: "after" },
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

// DELETE MY ACCOUNT (NDPR/GDPR right to erasure)
//
// Soft-deletes immediately (account becomes unusable — see
// authMiddleware/loginUser's deletedAt checks) and logs the requester
// out on this device. The actual hard-delete cascade is deferred to
// jobs/purgeDeletedAccounts.js after a 30-day grace period — see
// services/accountDeletionService.js for why that's a separate step.
//
// Requires the account password as confirmation, same reasoning as any
// other irreversible action gated behind re-entering a credential: a
// left-open session or a UI mis-click shouldn't be enough on its own to
// trigger something this consequential.
export const deleteMyAccount = async (req, res) => {
  try {
    const { password } = req.body;

    const user = await User.findById(req.user._id);
    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
      return res.status(400).json({ message: "Incorrect password." });
    }

    await softDeleteAccount(user._id);
    clearAuthCookies(res);

    res.status(200).json({
      message: "Your account has been deleted. This is reversible for 30 days — contact support if this wasn't you.",
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// EXPORT MY DATA (NDPR/GDPR data portability)
//
// Returns a single JSON document containing everything this endpoint's
// module comment (services/dataExportService.js) defines as "your data"
// — account fields, posts, comments, likes, bookmarks, social edges (as
// ids, not resolved profiles), messages, notifications, and reports
// filed. Not paginated or streamed: even an active user's total data
// volume here is small relative to, say, video bytes (which aren't
// included — media lives on Cloudinary and is referenced by URL, not
// re-exported as binary data).
export const exportMyData = async (req, res) => {
  try {
    const data = await buildUserDataExport(req.user);
    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
