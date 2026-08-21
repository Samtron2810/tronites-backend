import Post from "../models/Post.js";
import User from "../models/User.js";
import Comment from "../models/Comment.js";
import Notification from "../models/Notification.js";
import cloudinary from "../utils/cloudinary.js";
import { io, emitToUser, emitToFollowersOf } from "../socket/socket.js";
import {
  getOrSetCache,
  invalidateCache,
  getFeedCacheKey,
  invalidateFeedCache,
} from "../utils/redis.js";
import { uploadImageAndWait } from "../queues/imageUploadQueue.js";
import { listFollowingIds } from "../services/followService.js";
import { getMutedIds, hasMuted } from "../services/muteService.js";
import {
  getBlockedEitherWayIds,
  isBlockedEitherWay,
} from "../services/blockService.js";
import { extractHashtags, extractMentions } from "../utils/textParser.js";
import {
  hasLiked,
  getLikedPostIds,
  createLikeEdge,
  removeLikeEdge,
  removeAllLikesForPost,
} from "../services/likeService.js";
import {
  getBookmarkedPostIds,
  createBookmarkEdge,
  removeBookmarkEdge,
  removeAllBookmarksForPost,
  listBookmarkedPosts,
} from "../services/bookmarkService.js";

// CREATE POST — images now arrive as Cloudinary URLs (signed browser
// upload flow, see createImageUploadSignature). The frontend uploads
// directly to Cloudinary, gets back secure_urls, and sends them here.
// Legacy multer-file path is kept for backward compatibility with any
// older client still posting that way.
export const createPost = async (req, res) => {
  try {
    const { text } = req.body;
    // New path: images come as an array of Cloudinary URLs in the body.
    const bodyImages = Array.isArray(req.body.images) ? req.body.images : [];
    // Legacy path: multer files (upload.array). req.file: legacy single.
    const files = req.files?.length ? req.files : req.file ? [req.file] : [];

    if (!text?.trim() && bodyImages.length === 0 && files.length === 0) {
      return res.status(400).json({
        message: "Post must contain text or image",
      });
    }

    if (bodyImages.length + files.length > 4) {
      return res.status(400).json({ message: "Max 4 images per post" });
    }

    let imageUrls = [];

    if (bodyImages.length > 0) {
      // Validate the URLs come from our Cloudinary account to prevent
      // arbitrary URL injection into the DB.
      const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
      const allowedPrefix = `https://res.cloudinary.com/${cloudName}/`;
      const valid = bodyImages.every(
        (url) => typeof url === "string" && url.startsWith(allowedPrefix),
      );
      if (!valid) {
        return res.status(400).json({ message: "Invalid image URL" });
      }
      imageUrls = bodyImages;
    } else if (files.length > 0) {
      // Legacy multer path — upload via the image queue (kept for old
      // clients). New clients use the signed browser upload instead.
      try {
        const results = await Promise.all(
          files.map((file) => {
            const b64 = `data:${file.mimetype};base64,${file.buffer.toString("base64")}`;
            return uploadImageAndWait("post-image", {
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
          }),
        );
        imageUrls = results.map((r) => r.secureUrl);
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
      images: imageUrls,
      hashtags: extractHashtags(text),
    });
    const populatedPost = await post.populate("user", "name profilePic");

    // Notify mentioned users (skip self-mentions, blocked relationships,
    // and anyone who's muted the poster). Best-effort — a failure here
    // shouldn't fail the post creation, which has already succeeded by
    // this point.
    try {
      const mentionedUsernames = extractMentions(text);
      if (mentionedUsernames.length) {
        const mentionedUsers = await User.find({
          username: { $in: mentionedUsernames },
          _id: { $ne: req.user._id },
        }).select("_id");

        const blockedIds = await getBlockedEitherWayIds(req.user._id);

        await Promise.all(
          mentionedUsers
            .filter(
              (mentionedUser) => !blockedIds.has(mentionedUser._id.toString()),
            )
            .map(async (mentionedUser) => {
              // A mute is one-directional and only affects the muter's
              // own feed/notifications, not the sender's ability to
              // notify — check from the recipient's side: has the
              // person being mentioned muted the poster?
              if (await hasMuted(mentionedUser._id, req.user._id)) return;

              const newNotif = await Notification.create({
                recipient: mentionedUser._id,
                sender: req.user._id,
                type: "mention",
                post: post._id,
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
      console.error("Mention notification error:", mentionError.message);
    }

    // Invalidate feed cache for author's followers
    invalidateFeedCache(req.user._id);
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

// ─── Signed browser upload (Option B) ───────────────────────────────────────
// The frontend uploads media directly to Cloudinary (no Redis, no backend
// bandwidth). The backend only generates a signed upload request — the
// signature is an HMAC of the upload params + timestamp using the API
// secret, which never leaves the server. Cloudinary validates the
// signature before accepting the upload, so users can't upload to
// arbitrary folders or with arbitrary transformations.

const MAX_VIDEO_DURATION_SECONDS = 30;

// Generates signed upload params for a single image. The frontend calls
// this once per post (with the image count), then uploads each image
// directly to Cloudinary using the returned signature.
export const createImageUploadSignature = async (req, res) => {
  try {
    const timestamp = Math.round(Date.now() / 1000);
    const folder = "tronites_posts";
    const transformation = "w_1600,h_1600,c_limit,q_auto,f_auto";

    // Params that must be signed — Cloudinary rejects the upload if the
    // signature doesn't match these exact values.
    const paramsToSign = {
      timestamp,
      folder,
      transformation,
    };

    const signature = cloudinary.utils.api_sign_request(
      paramsToSign,
      process.env.CLOUDINARY_API_SECRET,
    );

    res.status(200).json({
      signature,
      timestamp,
      apiKey: process.env.CLOUDINARY_API_KEY,
      cloudName: process.env.CLOUDINARY_CLOUD_NAME,
      folder,
      transformation,
    });
  } catch (error) {
    console.error("CREATE IMAGE SIGNATURE ERROR:", error.message);
    res.status(500).json({ message: error.message });
  }
};

// Returns signed upload params for a direct browser video upload (the
// custom uploader replaces the old Cloudinary Upload Widget — see
// frontend/src/services/videoUpload.js). No post shell is created here:
// unlike the old webhook-driven flow, the frontend uploads first and
// only then calls POST /posts/video with the finished asset, so a post
// can never exist in a half-uploaded state. Eager is synchronous (no
// eager_async), so Cloudinary's upload response itself contains the
// trimmed/transformed MP4 URL — no webhook round-trip needed at all,
// which also removes the BACKEND_PUBLIC_URL requirement.
export const createVideoUploadSignature = async (req, res) => {
  try {
    const timestamp = Math.round(Date.now() / 1000);
    const folder = "tronites_videos";
    const eager = `so_0,du_${MAX_VIDEO_DURATION_SECONDS},f_mp4,vc_h264,q_auto`;

    // Params that must be signed — Cloudinary rejects the upload if the
    // signature doesn't match these exact values. The frontend must send
    // exactly these params (plus file/api_key/timestamp) and nothing else.
    const paramsToSign = { timestamp, folder, eager };

    const signature = cloudinary.utils.api_sign_request(
      paramsToSign,
      process.env.CLOUDINARY_API_SECRET,
    );

    res.status(200).json({
      signature,
      timestamp,
      apiKey: process.env.CLOUDINARY_API_KEY,
      cloudName: process.env.CLOUDINARY_CLOUD_NAME,
      folder,
      eager,
    });
  } catch (error) {
    console.error("CREATE VIDEO SIGNATURE ERROR:", error.message);
    res.status(500).json({ message: error.message });
  }
};

// CREATE VIDEO POST — called by the custom uploader AFTER the video has
// been uploaded directly to Cloudinary from the browser (signed via
// createVideoUploadSignature above). Because the upload response already
// contains the transformed asset (synchronous eager), the post is created
// fully "ready" in one shot — there is no processing state, no webhook,
// and therefore no way for a post to get stuck or be orphaned.
export const createVideoPost = async (req, res) => {
  try {
    const { text, video } = req.body;
    const { publicId, url, durationSeconds } = video;

    // Validate the asset belongs to our Cloudinary account and folder —
    // same arbitrary-URL-injection defense as image posts in createPost.
    const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
    const allowedPrefix = `https://res.cloudinary.com/${cloudName}/video/upload/`;
    if (
      typeof url !== "string" ||
      !url.startsWith(allowedPrefix) ||
      typeof publicId !== "string" ||
      !publicId.startsWith("tronites_videos/")
    ) {
      return res.status(400).json({ message: "Invalid video URL" });
    }

    // Thumbnail derivation: Cloudinary can generate a jpg frame from any
    // timestamp via a delivery URL — this constructs one at the 1-second
    // mark without a second upload/job. The eager MP4 URL already carries
    // its transformation segment (/upload/so_0,du_30,f_mp4,...), so that
    // segment must be REPLACED with so_1,f_jpg — blindly inserting another
    // segment in front of it would chain f_jpg with f_mp4 and produce a
    // broken image.
    const eagerSegment = `/upload/${`so_0,du_${MAX_VIDEO_DURATION_SECONDS},f_mp4,vc_h264,q_auto`}/`;
    let thumbnailUrl = url.replace(eagerSegment, "/upload/so_1,f_jpg/");
    if (!thumbnailUrl.includes("so_1,f_jpg")) {
      // Fallback: raw (non-eager) secure_url — insert after /upload/.
      thumbnailUrl = url.replace("/upload/", "/upload/so_1,f_jpg/");
    }
    thumbnailUrl = thumbnailUrl.replace(/\.mp4$/, ".jpg");

    const post = await Post.create({
      user: req.user._id,
      text,
      hashtags: extractHashtags(text),
      video: {
        publicId,
        url,
        thumbnailUrl,
        durationSeconds: durationSeconds || null,
        status: "ready",
      },
    });

    // Notify mentioned users (skip self-mentions, blocked relationships,
    // and anyone who's muted the poster). Best-effort — same as createPost.
    try {
      const mentionedUsernames = extractMentions(text);
      if (mentionedUsernames.length) {
        const mentionedUsers = await User.find({
          username: { $in: mentionedUsernames },
          _id: { $ne: req.user._id },
        }).select("_id");

        const blockedIds = await getBlockedEitherWayIds(req.user._id);

        await Promise.all(
          mentionedUsers
            .filter(
              (mentionedUser) => !blockedIds.has(mentionedUser._id.toString()),
            )
            .map(async (mentionedUser) => {
              if (await hasMuted(mentionedUser._id, req.user._id)) return;

              const newNotif = await Notification.create({
                recipient: mentionedUser._id,
                sender: req.user._id,
                type: "mention",
                post: post._id,
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
      console.error("Mention notification error:", mentionError.message);
    }

    invalidateFeedCache(req.user._id);
    invalidateCache(`profile-posts:${req.user._id}:*`);

    const populatedPost = await post.populate("user", "name profilePic");
    res.status(201).json(populatedPost);

    // Real-time post feed update for followers.
    try {
      emitToFollowersOf(req.user._id, "newPost", populatedPost);
    } catch (socketError) {
      console.error("Real-time feed emission error:", socketError);
    }
  } catch (error) {
    console.error("CREATE VIDEO POST ERROR:", error.message);
    res.status(500).json({ message: error.message });
  }
};

// EDIT POST (text-only — images are fixed after posting)
export const editPost = async (req, res) => {
  try {
    const post = await Post.findById(req.params.id);

    if (!post) {
      return res.status(404).json({ message: "Post not found" });
    }

    if (post.user.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: "Not authorized" });
    }

    const { text } = req.body;
    const hasImages = (post.images?.length || 0) > 0 || Boolean(post.image);

    if (!text?.trim() && !hasImages) {
      return res.status(400).json({
        message: "Post must contain text or image",
      });
    }

    const oldMentions = new Set(extractMentions(post.text));

    post.text = text;
    post.hashtags = extractHashtags(text);
    post.edited = true;
    post.editedAt = new Date();
    await post.save();

    const populatedPost = await post.populate("user", "name profilePic");

    // Notify newly-added mentions only — re-notifying every mention on
    // every edit would spam anyone already mentioned pre-edit.
    try {
      const newMentions = extractMentions(text).filter(
        (username) => !oldMentions.has(username),
      );
      if (newMentions.length) {
        const mentionedUsers = await User.find({
          username: { $in: newMentions },
          _id: { $ne: req.user._id },
        }).select("_id");

        const blockedIds = await getBlockedEitherWayIds(req.user._id);

        await Promise.all(
          mentionedUsers
            .filter(
              (mentionedUser) => !blockedIds.has(mentionedUser._id.toString()),
            )
            .map(async (mentionedUser) => {
              if (await hasMuted(mentionedUser._id, req.user._id)) return;

              const newNotif = await Notification.create({
                recipient: mentionedUser._id,
                sender: req.user._id,
                type: "mention",
                post: post._id,
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
      console.error("Edit mention notification error:", mentionError.message);
    }

    invalidateFeedCache(req.user._id);
    invalidateCache(`profile-posts:${req.user._id}:*`);

    res.status(200).json(populatedPost);

    try {
      io.to(`post_${post._id}`).emit("postUpdated", {
        postId: post._id,
        text: post.text,
        hashtags: post.hashtags,
        edited: true,
        editedAt: post.editedAt,
      });
    } catch (socketError) {
      console.error("Edit post emission error:", socketError);
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Stuck-post cleanup: a video post can be left in "processing" forever
// if the Cloudinary webhook never fires (e.g. the notification_url was
// unreachable, or the eager transformation silently failed). This
// fire-and-forget sweep marks any post stuck in "processing" for more
// than STALE_PROCESSING_MS as "failed" so the feed shows a clear error
// state instead of an infinite spinner. Runs on each feed fetch (cheap:
// one indexed query) and never blocks the response.
const STALE_PROCESSING_MS = 10 * 60 * 1000; // 10 minutes

const markStaleProcessingVideosAsFailed = async () => {
  try {
    const cutoff = new Date(Date.now() - STALE_PROCESSING_MS);
    await Post.updateMany(
      {
        "video.status": "processing",
        updatedAt: { $lt: cutoff },
      },
      { $set: { "video.status": "failed" } },
    );
  } catch (err) {
    console.error("Stale video cleanup error:", err.message);
  }
};

// GET PERSONALIZED FEED POSTS
export const getFeedPosts = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    // Fire-and-forget — don't block the feed response on cleanup.
    markStaleProcessingVideosAsFailed();

    const cacheKey = await getFeedCacheKey(req.user._id, page, limit);

    const result = await getOrSetCache(
      cacheKey,
      async () => {
        // Current logged in user
        const followingIds = await listFollowingIds(req.user._id);

        // Muting doesn't touch the follow edge (it's meant to be
        // silent and reversible without unfollowing) — so unlike a
        // block, a muted account's posts have to be filtered out here
        // explicitly rather than already being absent from
        // followingIds.
        const mutedIds = await getMutedIds(req.user._id);
        const visibleFollowingIds = followingIds.filter(
          (id) => !mutedIds.has(id),
        );

        // Users allowed in feed
        const feedUsers = [...visibleFollowingIds, req.user._id];

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

        // Bulk-check which of these posts the viewer has liked/bookmarked
        // — one query each instead of an in-memory array scan per post.
        const postIds = posts.map((p) => p._id);
        const [likedPostIds, bookmarkedPostIds] = await Promise.all([
          getLikedPostIds(req.user._id, postIds),
          getBookmarkedPostIds(req.user._id, postIds),
        ]);

        const formattedPosts = posts.map((post) => ({
          ...post._doc,
          isLiked: likedPostIds.has(post._id.toString()),
          isBookmarked: bookmarkedPostIds.has(post._id.toString()),
        }));

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

// GET POSTS BY HASHTAG
export const getPostsByHashtag = async (req, res) => {
  try {
    const tag = (req.params.tag || "").trim().toLowerCase();
    if (!tag) return res.status(400).json({ message: "Hashtag is required" });

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    const cacheKey = `hashtag:${tag}:${page}:${limit}`;

    // Shared across every viewer of this hashtag page (keyed only by
    // tag/page/limit) — same reasoning as profile-posts: isLiked/
    // isBookmarked are viewer-specific and must be computed per-request,
    // outside the cached fetchFn, not baked into the shared cache entry.
    const result = await getOrSetCache(
      cacheKey,
      async () => {
        const posts = await Post.find({ hashtags: tag })
          .populate("user", "name username profilePic")
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit);

        const totalPosts = await Post.countDocuments({ hashtags: tag });

        return {
          posts,
          totalPosts,
          hasMore: skip + posts.length < totalPosts,
        };
      },
      30,
    );

    const postIds = result.posts.map((p) => p._id);
    const [likedPostIds, bookmarkedPostIds] = await Promise.all([
      getLikedPostIds(req.user._id, postIds),
      getBookmarkedPostIds(req.user._id, postIds),
    ]);

    const formattedPosts = result.posts.map((post) => ({
      ...(post._doc || post),
      isLiked: likedPostIds.has(post._id.toString()),
      isBookmarked: bookmarkedPostIds.has(post._id.toString()),
    }));

    res.status(200).json({ ...result, posts: formattedPosts });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// SEARCH POSTS (content search — matches caption text via MongoDB $text)
export const searchPosts = async (req, res) => {
  try {
    const query = String(req.query.q || "").trim();
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(
      Math.max(parseInt(req.query.limit, 10) || 10, 1),
      30,
    );
    const skip = (page - 1) * limit;

    if (query.length < 2) {
      return res.status(200).json({ posts: [], hasMore: false });
    }

    // Block list changes which posts are even eligible to appear, so
    // it's part of the query filter (not a post-hoc per-row flag like
    // isLiked/isBookmarked below) — every viewer with a different block
    // list needs a genuinely different result set, so this can't be
    // shared across viewers regardless of cache key design. Not cached,
    // same as getFeedPosts's per-viewer nature but simpler since search
    // results are inherently low-traffic per unique query.
    const blockedIds = await getBlockedEitherWayIds(req.user._id);
    const filter = {
      $text: { $search: query },
      ...(blockedIds.size ? { user: { $nin: [...blockedIds] } } : {}),
    };

    const [posts, totalPosts] = await Promise.all([
      Post.find(filter, { score: { $meta: "textScore" } })
        .populate("user", "name username profilePic")
        .sort({ score: { $meta: "textScore" }, createdAt: -1 })
        .skip(skip)
        .limit(limit),
      Post.countDocuments(filter),
    ]);

    const postIds = posts.map((p) => p._id);
    const [likedPostIds, bookmarkedPostIds] = await Promise.all([
      getLikedPostIds(req.user._id, postIds),
      getBookmarkedPostIds(req.user._id, postIds),
    ]);

    const formattedPosts = posts.map((post) => ({
      ...post._doc,
      isLiked: likedPostIds.has(post._id.toString()),
      isBookmarked: bookmarkedPostIds.has(post._id.toString()),
    }));

    res.status(200).json({
      posts: formattedPosts,
      hasMore: skip + formattedPosts.length < totalPosts,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// LIKE/UNLIKE POST
export const likePost = async (req, res) => {
  try {
    const post = await Post.findById(req.params.id);

    if (!post) {
      return res.status(404).json({
        message: "Post not found",
      });
    }

    const userId = req.user._id;

    // Direct-ID access can reach a post even when it's absent from feed
    // /profile views (e.g. an old link, a cached client). Block still
    // applies — enforced here rather than relying on the post simply
    // being unreachable through normal browsing.
    if (
      post.user.toString() !== userId.toString() &&
      (await isBlockedEitherWay(userId, post.user))
    ) {
      return res
        .status(403)
        .json({ message: "You can't interact with this post." });
    }

    // Read-then-act, same as the follow/unfollow toggle — but the actual
    // race safety comes from the Like collection's unique {user, post}
    // index (see createLikeEdge/removeLikeEdge), not from this read. Two
    // concurrent "like" clicks can both see `alreadyLiked: false`; only
    // one of them will succeed in creating the edge, and the other's
    // createLikeEdge call becomes a no-op via the E11000 branch — so the
    // counter below never double-increments even under a race.
    const alreadyLiked = await hasLiked(userId, post._id);
    let liked;

    if (alreadyLiked) {
      // Unlike
      const removed = await removeLikeEdge(userId, post._id);
      liked = false;
      if (removed) {
        post.likesCount = Math.max(0, post.likesCount - 1);
        await post.updateOne({ $inc: { likesCount: -1 } });

        // Remove like notification
        await Notification.deleteOne({
          recipient: post.user,
          sender: userId,
          type: "like",
          post: post._id,
        });
      }
    } else {
      // Like
      const created = await createLikeEdge(userId, post._id);
      liked = true;
      if (created) {
        post.likesCount += 1;
        await post.updateOne({ $inc: { likesCount: 1 } });

        // Create like notification (don't notify yourself, or a poster
        // who's muted this liker)
        if (
          post.user.toString() !== userId.toString() &&
          !(await hasMuted(post.user, userId))
        ) {
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
    }

    // Invalidate feed caches for both users
    invalidateFeedCache(req.user._id);
    invalidateFeedCache(post.user);

    // Emit "likeUpdate" to the post's specific room. Sends only the count
    // and the acting user's own like state — not the full liker list,
    // which used to leak every liker's identity to every room member on
    // every single like (O(N) payload growing with popularity). Clients
    // that need "who liked this" fetch it via a dedicated paginated
    // endpoint instead (listLikers in likeService).
    try {
      io.to(`post_${post._id}`).emit("likeUpdate", {
        postId: post._id,
        likesCount: post.likesCount,
        userId: userId.toString(),
        liked,
      });
    } catch (socketError) {
      console.error("Like count emission error:", socketError);
    }

    res.status(200).json({
      likes: post.likesCount,
      liked,
    });
  } catch (error) {
    res.status(500).json({
      message: error.message,
    });
  }
};

// TOGGLE BOOKMARK (save/unsave)
export const toggleBookmark = async (req, res) => {
  try {
    const post = await Post.findById(req.params.id).select("_id user");
    if (!post) {
      return res.status(404).json({ message: "Post not found" });
    }

    const userId = req.user._id;

    if (
      post.user.toString() !== userId.toString() &&
      (await isBlockedEitherWay(userId, post.user))
    ) {
      return res
        .status(403)
        .json({ message: "You can't interact with this post." });
    }

    // Read-then-act, race safety comes from the unique {user, post}
    // index (see likePost's comment — same pattern).
    const existing = await removeBookmarkEdge(userId, post._id);
    let bookmarked;
    if (existing) {
      bookmarked = false;
    } else {
      await createBookmarkEdge(userId, post._id);
      bookmarked = true;
    }

    res.status(200).json({ bookmarked });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// GET MY BOOKMARKED POSTS (paginated)
export const getBookmarkedPosts = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 12;
    const skip = (page - 1) * limit;

    const { posts, totalBookmarks } = await listBookmarkedPosts(req.user._id, {
      skip,
      limit,
    });

    const likedPostIds = await getLikedPostIds(
      req.user._id,
      posts.map((p) => p._id),
    );

    const formattedPosts = posts.map((post) => ({
      ...post._doc,
      isLiked: likedPostIds.has(post._id.toString()),
      isBookmarked: true,
    }));

    res.status(200).json({
      posts: formattedPosts,
      totalBookmarks,
      currentPage: page,
      totalPages: Math.ceil(totalBookmarks / limit),
      hasMore: skip + posts.length < totalBookmarks,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
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

    // Delete Cloudinary image(s) safely — legacy single `image` plus any
    // carousel `images`, deleted in parallel and independently so one
    // failure doesn't block the others.
    const urlsToDelete = [post.image, ...(post.images || [])].filter(Boolean);
    await Promise.all(
      urlsToDelete.map(async (url) => {
        try {
          const publicId = url.split("/").slice(-1)[0].split(".")[0];
          await cloudinary.uploader.destroy(`tronites_posts/${publicId}`);
        } catch (err) {
          console.log("Cloudinary delete failed:", err.message);
        }
      }),
    );

    // Delete Cloudinary video, if any — uses the stored publicId
    // directly (recorded at upload time in videoUploadWorker.js) rather
    // than parsing it back out of a URL like the images above do, and
    // needs resource_type: "video" since Cloudinary namespaces
    // image/video destroy calls separately.
    if (post.video?.publicId) {
      try {
        await cloudinary.uploader.destroy(post.video.publicId, {
          resource_type: "video",
        });
      } catch (err) {
        console.log("Cloudinary video delete failed:", err.message);
      }
    }

    // Delete related comments
    await Comment.deleteMany({ post: post._id });

    // Delete related likes/bookmarks — otherwise these edges would stay
    // orphaned, referencing a post that no longer exists.
    await removeAllLikesForPost(post._id);
    await removeAllBookmarksForPost(post._id);

    await post.deleteOne();

    // Invalidate feed cache
    invalidateFeedCache(req.user._id);
    invalidateCache(`profile-posts:${req.user._id}:*`);

    res.status(200).json({ message: "Post deleted" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
