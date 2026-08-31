import Post from "../models/Post.js";
import Repost from "../models/Repost.js";
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
import {
  canViewPost,
  isRepostable,
  PUBLIC_ONLY_FILTER,
  feedVisibilityFilter,
  POST_PRIVACY,
} from "../services/postVisibilityService.js";
import { getMutedIds, hasMuted } from "../services/muteService.js";
import {
  getBlockedEitherWayIds,
  isBlockedEitherWay,
} from "../services/blockService.js";
import { getForYouCandidates } from "../services/forYouService.js";
import {
  isExplicitlyFollowingHashtag,
  followHashtag,
  unfollowHashtag,
  listExplicitlyFollowedHashtags,
} from "../services/hashtagFollowService.js";
import { checkEngagementVelocity } from "../services/engagementVelocityService.js";
import {
  parseSearchFilters,
  dateRangeFilter,
  hasMediaFilter,
} from "../services/searchService.js";
import { extractHashtags, extractMentions } from "../utils/textParser.js";
import {
  hasLiked,
  getLikedPostIds,
  createLikeEdge,
  removeLikeEdge,
  removeAllLikesForPost,
} from "../services/likeService.js";
import {
  getUserReaction,
  getReactionSummary,
  getReactionSummaries,
  getUserReactions,
  setReaction,
  removeReaction,
  removeAllReactionsForTarget,
  REACTION_EMOJIS,
} from "../services/reactionService.js";
import {
  getBookmarkedPostIds,
  createBookmarkEdge,
  removeBookmarkEdge,
  removeAllBookmarksForPost,
  listBookmarkedPosts,
} from "../services/bookmarkService.js";
import {
  hasReposted,
  getRepostedPostIds,
  getRepostCounts,
  createRepostEdge,
  removeRepostEdge,
  removeAllRepostsForPost,
} from "../services/repostService.js";

// CREATE POST — images now arrive as Cloudinary URLs (signed browser
// upload flow, see createImageUploadSignature). The frontend uploads
// directly to Cloudinary, gets back secure_urls, and sends them here.
// Legacy multer-file path is kept for backward compatibility with any
// older client still posting that way.
export const createPost = async (req, res) => {
  try {
    const { text, privacy } = req.body;
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
      privacy,
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
    // only-me posts never emit — a follower's live feed shouldn't prepend
    // a post their DB feed query would never have returned in the first
    // place.
    try {
      if (post.privacy !== POST_PRIVACY.ONLY_ME) {
        emitToFollowersOf(req.user._id, "newPost", populatedPost);
      }
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
    const { text, video, privacy } = req.body;
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
      privacy,
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

    // Real-time post feed update for followers. only-me posts never emit —
    // same reasoning as createPost above.
    try {
      if (post.privacy !== POST_PRIVACY.ONLY_ME) {
        emitToFollowersOf(req.user._id, "newPost", populatedPost);
      }
    } catch (socketError) {
      console.error("Real-time feed emission error:", socketError);
    }
  } catch (error) {
    console.error("CREATE VIDEO POST ERROR:", error.message);
    res.status(500).json({ message: error.message });
  }
};

// EDIT POST (text-only — images are fixed after posting)
// 1-hour cooldown between post edits, gated from the 2nd edit onward —
// editedAt starts null so the first edit is always allowed with no
// special-casing needed.
const POST_EDIT_COOLDOWN_MS = 60 * 60 * 1000;

export const editPost = async (req, res) => {
  try {
    const post = await Post.findById(req.params.id);

    if (!post) {
      return res.status(404).json({ message: "Post not found" });
    }

    if (post.user.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: "Not authorized" });
    }

    if (post.editedAt) {
      const elapsed = Date.now() - post.editedAt.getTime();
      if (elapsed < POST_EDIT_COOLDOWN_MS) {
        const nextAllowed = new Date(
          post.editedAt.getTime() + POST_EDIT_COOLDOWN_MS,
        );
        return res.status(429).json({
          message: "You can only edit a post once every hour",
          nextAllowedAt: nextAllowed,
        });
      }
    }

    const { text } = req.body;
    const hasImages = (post.images?.length || 0) > 0;

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
// GET PERSONALIZED FEED POSTS
//
// Cursor-based (keyset) pagination on _id, not offset/skip. With skip(),
// (a) skip() gets slow scanning past N discarded docs on large
// collections, and (b) a post created between two page fetches shifts
// every subsequent page by one, so page 2 duplicates page 1's last item.
// _id is ObjectId, which is monotonically increasing with createdAt for
// this app's insert pattern, so `_id < cursor` is equivalent to
// `createdAt < cursor's createdAt` but is a single indexed inequality
// instead of a skip — correct regardless of inserts happening mid-scroll.
//
// Feed items now come from TWO sources merged into one timeline:
//   1. Posts authored by feedUsers — ordinary text/image/video posts.
//   2. Repost edges BY feedUsers, of EITHER kind:
//        - plain repost (isQuote: false) -> rendered as the original
//          post with a "Reposted by X" header, no separate body.
//        - quote (isQuote: true) -> rendered as its own item with the
//          quoter's text/hashtags PLUS the embedded original
//          (`quoteOf`) below it. A quote is NOT a Post document (see
//          models/Repost.js) — it only has feed-item shape here, at
//          read time, by merging the Repost edge's own text with its
//          populated `post` reference.
// The merge cursor is a single ISO string (`before`) compared against
// each source's own timestamp field (Post.createdAt for source 1,
// Repost.createdAt for source 2) — not a compound cursor — because
// both sources sort on "when did this enter the feed", which for a
// repost/quote is the repost/quote time, not the original post's
// createdAt. This keeps a single-field keyset cursor intact while
// letting a stale repost of an old post surface at its own recency.
export const getFeedPosts = async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 10, 1), 30);
    const cursor = req.query.before; // ISO timestamp from the previous page's last item

    // Fire-and-forget — don't block the feed response on cleanup.
    markStaleProcessingVideosAsFailed();

    const cacheKey = await getFeedCacheKey(req.user._id, cursor || "start", limit);

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

        const cursorDate = cursor ? new Date(cursor) : null;

        // ── Source 1: authored posts — ordinary posts AND quote posts
        // both live in the Post collection now (a quote is a real Post
        // with `quoteOf` set), so one query covers both; `quoteOf` is
        // populated below so a quote's embedded original renders
        // without a second round trip. Over-fetch by `limit` on BOTH
        // sources so the in-memory merge below still has enough of
        // each to fill a full page even when one source dominates.
        const postFilter = {
          user: { $in: feedUsers },
          removedAt: null, // moderator soft-takedown — see reportService
          ...feedVisibilityFilter(req.user._id),
          ...(cursorDate ? { createdAt: { $lt: cursorDate } } : {}),
        };
        const postCandidates = await Post.find(postFilter)
          .populate("user", "name username profilePic")
          .populate({
            path: "quoteOf",
            populate: { path: "user", select: "name username profilePic" },
          })
          .sort({ createdAt: -1 })
          .limit(limit + 1);

        // ── Source 2: repost edges by feedUsers — always a thin
        // pointer at a post (ordinary or quote), never carries its own
        // content anymore. Reposting your OWN post/quote is excluded
        // (a no-op action, nothing new to show); quoting your own post
        // is unaffected since a quote is a distinct authored Post
        // that already comes through Source 1. The pointed-at post
        // must still be public + not removed — a repost of a
        // since-privatized or moderator-removed post shouldn't
        // resurrect it into anyone's feed.
        const repostFilter = {
          user: { $in: feedUsers },
          ...(cursorDate ? { createdAt: { $lt: cursorDate } } : {}),
        };
        const repostCandidates = await Repost.find(repostFilter)
          .populate("user", "name username profilePic")
          .populate({
            path: "post",
            match: { removedAt: null, ...PUBLIC_ONLY_FILTER },
            populate: [
              { path: "user", select: "name username profilePic" },
              {
                path: "quoteOf",
                populate: { path: "user", select: "name username profilePic" },
              },
            ],
          })
          .sort({ createdAt: -1 })
          .limit(limit + 1);

        // Drop edges whose target didn't survive the populate match
        // (removed/privatized since), and drop self-reposts.
        const validRepostEdges = repostCandidates.filter(
          (r) => r.post && r.post.user._id.toString() !== r.user._id.toString(),
        );

        // ── Merge: normalize both sources into one shape with a
        // common `sortAt` field, sort desc, slice to a page. Dedup
        // rule: if the SAME post appears more than once in this
        // window (e.g. reposted by two people you follow, or both
        // authored-and-reposted), keep only the most recent occurrence
        // by sortAt.
        const items = [
          ...postCandidates.map((post) => ({
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

        const seenKeys = new Set();
        const deduped = [];
        for (const item of items) {
          if (seenKeys.has(item.dedupeKey)) continue;
          seenKeys.add(item.dedupeKey);
          deduped.push(item);
        }

        const hasMore = deduped.length > limit;
        const page = hasMore ? deduped.slice(0, limit) : deduped;

        // Bulk-check like/bookmark/repost state for every post shown
        // AND every embedded original (quoteOf) — one query each
        // instead of an in-memory scan per item. A quote and the post
        // it embeds are independent Post documents, each with their
        // own like/bookmark/repost state.
        const postIds = page.map((item) => item.post._id);
        const quoteOfIds = page
          .filter((item) => item.post.quoteOf)
          .map((item) => item.post.quoteOf._id);
        const allIds = [...postIds, ...quoteOfIds];
        const [likedPostIds, bookmarkedPostIds, repostedPostIds, reactionSummaries, myReactions] = await Promise.all([
          getLikedPostIds(req.user._id, allIds),
          getBookmarkedPostIds(req.user._id, allIds),
          getRepostedPostIds(req.user._id, allIds),
          getReactionSummaries("post", allIds),
          getUserReactions(req.user._id, "post", allIds),
        ]);

        const formatPost = (post) => ({
          ...post._doc,
          isLiked: likedPostIds.has(post._id.toString()),
          isBookmarked: bookmarkedPostIds.has(post._id.toString()),
          isReposted: repostedPostIds.has(post._id.toString()),
          isQuotePost: Boolean(post.quoteOf),
          quoteOf: post.quoteOf ? formatQuoteOf(post.quoteOf) : null,
          reactionSummary: reactionSummaries.get(post._id.toString()) || {},
          myReaction: myReactions.get(post._id.toString()) || null,
        });

        // The embedded original never itself carries a nested
        // quoteOf (one level of embedding only), so no recursion here.
        const formatQuoteOf = (quoteOfDoc) => ({
          ...quoteOfDoc._doc,
          isLiked: likedPostIds.has(quoteOfDoc._id.toString()),
          isBookmarked: bookmarkedPostIds.has(quoteOfDoc._id.toString()),
          isReposted: repostedPostIds.has(quoteOfDoc._id.toString()),
          reactionSummary: reactionSummaries.get(quoteOfDoc._id.toString()) || {},
          myReaction: myReactions.get(quoteOfDoc._id.toString()) || null,
        });

        const formattedPosts = page.map((item) => ({
          ...formatPost(item.post),
          repostedBy: item.reposter
            ? {
                _id: item.reposter._id,
                name: item.reposter.name,
                username: item.reposter.username,
              }
            : null,
        }));

        return {
          posts: formattedPosts,
          hasMore,
          nextCursor: hasMore
            ? page[page.length - 1].sortAt.toISOString()
            : null,
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

// GET FOR YOU FEED
//
// Ranked, personalized feed — replaces Trending as Home's second tab
// (see tab-architecture.html). Sources: followed + friends-of-follows +
// trending, blended by computeForYouScore (services/forYouService.js),
// which ranks on Bayesian-smoothed engagement RATE rather than raw
// volume so audience size stops being the deciding factor (see
// TRONITES_RANKING_FAIRNESS.md for the full worked proof). Following
// stays untouched as the strictly-chronological, unranked tab.
//
// Not cached like getFeedPosts — the per-viewer candidate assembly
// (2 extra population queries) is heavier, but affinity/exploration
// slot content is meant to shift between loads more than a plain
// following feed, so a 30s cache would mostly hide the personalization
// this endpoint exists to provide. Revisit if load becomes a problem —
// same getFeedCacheKey/getOrSetCache plumbing is right there if needed.
export const getForYouFeed = async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 10, 1), 30);
    // Opaque cursor: comma-joined post ids already delivered, same
    // exclude-what-you've-seen approach Trending uses for the same
    // reason (a computed, unstored score can't back a DB cursor).
    const rawExcludeIds = String(req.query.excludeIds || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const excludePostIds = rawExcludeIds.slice(0, 400);

    const [blockedIds, mutedIds] = await Promise.all([
      getBlockedEitherWayIds(req.user._id),
      getMutedIds(req.user._id),
    ]);
    const excludeUserIds = [...blockedIds, ...mutedIds];

    const { page, hasMore } = await getForYouCandidates({
      viewerId: req.user._id,
      excludeUserIds,
      excludePostIds,
      limit,
    });

    const postIds = page.map(({ post }) => post._id);
    const quoteOfIds = page
      .filter(({ post }) => post.quoteOf)
      .map(({ post }) => post.quoteOf._id);
    const allIds = [...postIds, ...quoteOfIds];
    const [likedPostIds, bookmarkedPostIds, repostedPostIds, reactionSummaries, myReactions] = await Promise.all([
      getLikedPostIds(req.user._id, allIds),
      getBookmarkedPostIds(req.user._id, allIds),
      getRepostedPostIds(req.user._id, allIds),
      getReactionSummaries("post", allIds),
      getUserReactions(req.user._id, "post", allIds),
    ]);

    const formatQuoteOf = (quoteOfDoc) => ({
      ...quoteOfDoc._doc,
      isLiked: likedPostIds.has(quoteOfDoc._id.toString()),
      isBookmarked: bookmarkedPostIds.has(quoteOfDoc._id.toString()),
      isReposted: repostedPostIds.has(quoteOfDoc._id.toString()),
      reactionSummary: reactionSummaries.get(quoteOfDoc._id.toString()) || {},
      myReaction: myReactions.get(quoteOfDoc._id.toString()) || null,
    });

    const formattedPosts = page.map(({ post, source }) => ({
      ...post._doc,
      isLiked: likedPostIds.has(post._id.toString()),
      isBookmarked: bookmarkedPostIds.has(post._id.toString()),
      isReposted: repostedPostIds.has(post._id.toString()),
      isQuotePost: Boolean(post.quoteOf),
      quoteOf: post.quoteOf ? formatQuoteOf(post.quoteOf) : null,
      reactionSummary: reactionSummaries.get(post._id.toString()) || {},
      myReaction: myReactions.get(post._id.toString()) || null,
      // Lets the frontend render a subtle "why am I seeing this" badge
      // (e.g. "From a friend of someone you follow") without a second
      // lookup. Never shown for plain `followed` — that needs no
      // explanation.
      forYouSource: source,
    }));

    res.status(200).json({
      posts: formattedPosts,
      hasMore,
      nextCursor: hasMore
        ? [...excludePostIds, ...postIds.map((id) => id.toString())].join(",")
        : null,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// GET TRENDING FEED POSTS
//
// Reddit "hot"-style ranking: score = (likes*2 + comments*3) decayed by
// post age, so a post's rank falls off over time instead of older
// high-engagement posts permanently dominating the top. Gravity of 1.8
// and the 2h origin offset are tuned so a fresh post with a handful of
// early likes can outrank a day-old post with dozens, without a brand
// new zero-engagement post always winning on recency alone.
//
// Score isn't stored on the Post doc — it's cheap to compute at read
// time from the two counters already denormalized there (likesCount,
// commentsCount), and keeping it uncomputed avoids a write-amplifying
// background job to keep a stored score fresh as engagement changes.
// Same reasoning as searchPosts: a $meta-projected/computed score can't
// be combined with $lt in the query stage, so pagination is a capped
// in-memory candidate window ranked and sliced by (score, _id), not a
// true DB-level cursor. Global (not follow-scoped) by design — trending
// surfaces content across the whole app, mirroring Twitter/Instagram's
// "Trending"/"Explore" rather than the chronological following feed.
const TRENDING_GRAVITY = 1.8;
const TRENDING_ORIGIN_HOURS = 2;
const MAX_TRENDING_CANDIDATES = 500;
// Only rank posts from the last N days — older posts are excluded
// outright rather than merely decayed near-zero, so the candidate scan
// stays bounded regardless of how large the total post collection grows.
const TRENDING_WINDOW_DAYS = 7;

const computeTrendingScore = (post) => {
  const ageHours =
    (Date.now() - post.createdAt.getTime()) / (1000 * 60 * 60);
  const engagement = post.likesCount * 2 + post.commentsCount * 3;
  return engagement / Math.pow(ageHours + TRENDING_ORIGIN_HOURS, TRENDING_GRAVITY);
};

export const getTrendingPosts = async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 10, 1), 30);
    const cursorScore =
      req.query.afterScore !== undefined
        ? parseFloat(req.query.afterScore)
        : null;
    const cursorId = req.query.afterId || null;
    const hasCursor =
      cursorScore !== null && cursorId && !Number.isNaN(cursorScore);

    // Post IDs the caller has already seen (delivered on earlier pages).
    // Trending scores decay with age between requests, so a post that was
    // on page 1 can drop below the page-1 cursor by the time page 2 is
    // fetched and get re-served. The client sends us the IDs it already
    // has; we hard-exclude them before slicing so nothing can ever be
    // delivered twice, regardless of how much the ranking shifts. Capped
    // defensively so a pathological client can't blow up the query.
    const rawExcludeIds = String(req.query.excludeIds || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const excludeIds = new Set(
      rawExcludeIds.length <= 200 ? rawExcludeIds : rawExcludeIds.slice(0, 200),
    );

    // Same reasoning as searchPosts: block list changes which posts are
    // even eligible, so it's a query filter, not a post-hoc flag — not
    // cacheable/shareable across viewers as a result.
    const [blockedIds, mutedIds] = await Promise.all([
      getBlockedEitherWayIds(req.user._id),
      getMutedIds(req.user._id),
    ]);
    const excludedUserIds = new Set([...blockedIds, ...mutedIds]);

    const since = new Date(
      Date.now() - TRENDING_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    );

    const filter = {
      removedAt: null, // moderator soft-takedown — see reportService
      createdAt: { $gte: since },
      // Trending is a global discovery surface — only public posts
      // qualify (the shared cache must stay viewer-independent).
      ...PUBLIC_ONLY_FILTER,
      // Fairness fix #2 — velocity-flagged posts (see
      // services/engagementVelocityService.js) are excluded from
      // Trending, same as For You's discovery sources. Trending is
      // exactly the kind of high-visibility surface a bought-engagement
      // push is trying to reach, so this is the highest-value place to
      // enforce the flag.
      velocityFlagged: { $ne: true },
      ...(excludedUserIds.size
        ? { user: { $nin: [...excludedUserIds] } }
        : {}),
    };

    const candidates = await Post.find(filter)
      .populate("user", "name username profilePic")
      .populate({
        path: "quoteOf",
        populate: { path: "user", select: "name username profilePic" },
      })
      .sort({ createdAt: -1 })
      .limit(MAX_TRENDING_CANDIDATES);

    const ranked = candidates
      .map((post) => ({ post, score: computeTrendingScore(post) }))
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return b.post._id.toString().localeCompare(a.post._id.toString());
      })
      .filter(({ post }) => !excludeIds.has(post._id.toString()));

    const filtered = hasCursor
      ? ranked.filter(({ post, score }) => {
          if (score < cursorScore) return true;
          if (score === cursorScore) return post._id.toString() < cursorId;
          return false;
        })
      : ranked;

    const hasMore = filtered.length > limit;
    const page = hasMore ? filtered.slice(0, limit) : filtered;

    const postIds = page.map(({ post }) => post._id);
    const quoteOfIds = page
      .filter(({ post }) => post.quoteOf)
      .map(({ post }) => post.quoteOf._id);
    const allIds = [...postIds, ...quoteOfIds];
    const [likedPostIds, bookmarkedPostIds, repostedPostIds, reactionSummaries, myReactions] = await Promise.all([
      getLikedPostIds(req.user._id, allIds),
      getBookmarkedPostIds(req.user._id, allIds),
      getRepostedPostIds(req.user._id, allIds),
      getReactionSummaries('post', allIds),
      getUserReactions(req.user._id, 'post', allIds),
    ]);

    const formatQuoteOf = (quoteOfDoc) => ({
      ...quoteOfDoc._doc,
      isLiked: likedPostIds.has(quoteOfDoc._id.toString()),
      isBookmarked: bookmarkedPostIds.has(quoteOfDoc._id.toString()),
      isReposted: repostedPostIds.has(quoteOfDoc._id.toString()),
      reactionSummary: reactionSummaries.get(quoteOfDoc._id.toString()) || {},
      myReaction: myReactions.get(quoteOfDoc._id.toString()) || null,
    });

    const formattedPosts = page.map(({ post }) => ({
      ...post._doc,
      isLiked: likedPostIds.has(post._id.toString()),
      isBookmarked: bookmarkedPostIds.has(post._id.toString()),
      isReposted: repostedPostIds.has(post._id.toString()),
      isQuotePost: Boolean(post.quoteOf),
      quoteOf: post.quoteOf ? formatQuoteOf(post.quoteOf) : null,
      reactionSummary: reactionSummaries.get(post._id.toString()) || {},
      myReaction: myReactions.get(post._id.toString()) || null,
    }));

    res.status(200).json({
      posts: formattedPosts,
      hasMore,
      nextCursor: hasMore
        ? {
            afterScore: page[page.length - 1].score,
            afterId: page[page.length - 1].post._id,
          }
        : null,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// GET TRENDING HASHTAGS
//
// Aggregates over the last 24h, ranking tags by distinct-author count
// (not raw post count) — a single user spamming the same tag 50 times
// shouldn't out-rank a tag genuinely used by 10 different people. Only
// public posts count (same PUBLIC_ONLY_FILTER as trending posts/search
// — this is a shared, viewer-independent surface, so it can't leak
// followers/only-me content into a global ranking). Cached briefly in
// Redis since the aggregation re-scans the last 24h of posts on a miss.
const TRENDING_HASHTAGS_WINDOW_HOURS = 24;
const TRENDING_HASHTAGS_CACHE_TTL_SECONDS = 300; // 5 min

export const getTrendingHashtags = async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 10, 1), 30);
    const cacheKey = `trending-hashtags:${limit}`;

    const result = await getOrSetCache(
      cacheKey,
      async () => {
        const since = new Date(
          Date.now() - TRENDING_HASHTAGS_WINDOW_HOURS * 60 * 60 * 1000,
        );

        const rows = await Post.aggregate([
          {
            $match: {
              removedAt: null,
              createdAt: { $gte: since },
              hashtags: { $exists: true, $ne: [] },
              ...PUBLIC_ONLY_FILTER,
            },
          },
          // One row per (post, tag) pair — a post using the same tag
          // isn't possible since extractHashtags dedupes at parse time,
          // but $unwind is what lets us count per-tag below regardless.
          { $unwind: "$hashtags" },
          {
            $group: {
              _id: { tag: "$hashtags", user: "$user" },
              postCount: { $sum: 1 },
            },
          },
          // Collapse to one row per tag: distinct authors is the group
          // count here (each _id.user contributes exactly one row from
          // the previous stage), postCount sums back to total posts.
          {
            $group: {
              _id: "$_id.tag",
              authorCount: { $sum: 1 },
              postCount: { $sum: "$postCount" },
            },
          },
          { $sort: { authorCount: -1, postCount: -1, _id: 1 } },
          { $limit: limit },
          {
            $project: {
              _id: 0,
              tag: "$_id",
              authorCount: 1,
              postCount: 1,
            },
          },
        ]);

        return rows;
      },
      TRENDING_HASHTAGS_CACHE_TTL_SECONDS,
    );

    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// GET POSTS BY HASHTAG
export const getPostsByHashtag = async (req, res) => {
  try {
    const tag = (req.params.tag || "").trim().toLowerCase();
    if (!tag) return res.status(400).json({ message: "Hashtag is required" });

    const limit = Math.min(Math.max(parseInt(req.query.limit) || 10, 1), 30);
    const cursor = req.query.before; // last post _id from the previous page

    const cacheKey = `hashtag:${tag}:${cursor || "start"}:${limit}`;

    // Shared across every viewer of this hashtag page (keyed only by
    // tag/cursor/limit) — same reasoning as profile-posts: isLiked/
    // isBookmarked are viewer-specific and must be computed per-request,
    // outside the cached fetchFn, not baked into the shared cache entry.
    const result = await getOrSetCache(
      cacheKey,
      async () => {
        const filter = {
          hashtags: tag,
          removedAt: null, // moderator soft-takedown — see reportService
          // Hashtag browsing is a global discovery surface — public
          // posts only (shared cache stays viewer-independent).
          ...PUBLIC_ONLY_FILTER,
          ...(cursor ? { _id: { $lt: cursor } } : {}),
        };

        const posts = await Post.find(filter)
          .populate("user", "name username profilePic")
          .populate({
            path: "quoteOf",
            populate: { path: "user", select: "name username profilePic" },
          })
          .sort({ _id: -1 })
          .limit(limit + 1);

        const hasMore = posts.length > limit;
        const page = hasMore ? posts.slice(0, limit) : posts;

        return {
          posts: page,
          hasMore,
          nextCursor: hasMore ? page[page.length - 1]._id : null,
        };
      },
      30,
    );

    const postIds = result.posts.map((p) => p._id);
    const quoteOfIds = result.posts
      .filter((p) => p.quoteOf)
      .map((p) => p.quoteOf._id);
    const allIds = [...postIds, ...quoteOfIds];
    const [likedPostIds, bookmarkedPostIds, repostedPostIds, reactionSummaries, myReactions] = await Promise.all([
      getLikedPostIds(req.user._id, allIds),
      getBookmarkedPostIds(req.user._id, allIds),
      getRepostedPostIds(req.user._id, allIds),
      getReactionSummaries('post', allIds),
      getUserReactions(req.user._id, 'post', allIds),
    ]);

    const formatQuoteOf = (quoteOfDoc) => ({
      ...(quoteOfDoc._doc || quoteOfDoc),
      isLiked: likedPostIds.has(quoteOfDoc._id.toString()),
      isBookmarked: bookmarkedPostIds.has(quoteOfDoc._id.toString()),
      isReposted: repostedPostIds.has(quoteOfDoc._id.toString()),
      reactionSummary: reactionSummaries.get(quoteOfDoc._id.toString()) || {},
      myReaction: myReactions.get(quoteOfDoc._id.toString()) || null,
    });

    const formattedPosts = result.posts.map((post) => ({
      ...(post._doc || post),
      isLiked: likedPostIds.has(post._id.toString()),
      isBookmarked: bookmarkedPostIds.has(post._id.toString()),
      isReposted: repostedPostIds.has(post._id.toString()),
      isQuotePost: Boolean(post.quoteOf),
      quoteOf: post.quoteOf ? formatQuoteOf(post.quoteOf) : null,
      reactionSummary: reactionSummaries.get(post._id.toString()) || {},
      myReaction: myReactions.get(post._id.toString()) || null,
    }));

    res.status(200).json({ ...result, posts: formattedPosts });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// 2.3 — FOLLOW / UNFOLLOW HASHTAG
//
// Toggle endpoints (mirrors the like/bookmark/repost PUT-toggle pattern
// elsewhere in this controller) rather than separate follow/unfollow
// routes — one route, body-less, idempotent either direction. Tag is
// normalized (trim/lowercase) the same way Post.hashtags are parsed, so
// "#AfroBeats" and "afrobeats" resolve to the same edge.
//
// Keys off EXPLICIT follow state, not "any edge exists" — a tag the
// nightly job auto-followed for this user (see
// jobs/computeForYouSignals.js's recomputeImplicitHashtagFollows) must
// still show as "Follow" to them and, when tapped, upgrade that
// implicit edge to explicit (handled inside followHashtag) rather than
// deleting it. Toggling off an explicit follow the user is unaware they
// implicitly had would be a confusing, unrequested unfollow.
export const toggleHashtagFollow = async (req, res) => {
  try {
    const tag = String(req.params.tag || "").trim().toLowerCase();
    if (!tag) return res.status(400).json({ message: "Hashtag is required" });

    const alreadyFollowing = await isExplicitlyFollowingHashtag(req.user._id, tag);
    if (alreadyFollowing) {
      await unfollowHashtag(req.user._id, tag);
      return res.status(200).json({ following: false, tag });
    }
    await followHashtag(req.user._id, tag);
    return res.status(200).json({ following: true, tag });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// List the tags the current user EXPLICITLY follows — settings/
// hashtags page. Implicit (auto-derived) follows are intentionally
// excluded here: they still feed For You's interest source (see
// forYouService.js, which reads ALL edges via listFollowedHashtags),
// but showing them on a page titled "hashtags you follow" would
// surprise a user who never chose them.
export const getFollowedHashtags = async (req, res) => {
  try {
    const tags = await listExplicitlyFollowedHashtags(req.user._id);
    res.status(200).json({ tags });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// SEARCH POSTS (content search — matches caption text via MongoDB $text)
//
// Sort is (textScore desc, _id desc) — relevance first, recency as a
// tiebreaker among equally-relevant posts. skip()-based pagination has
// the same problems here as feed/hashtag, but the cursor can't be a bare
// _id like those use, since ordering isn't purely chronological: a page-2
// request needs "give me results ranked below the last one I saw", i.e.
// (score < lastScore) OR (score == lastScore AND _id < lastId). That
// compound condition is what keeps relevance ordering correct while
// still avoiding skip().
export const searchPosts = async (req, res) => {
  try {
    const query = String(req.query.q || "").trim();
    const limit = Math.min(
      Math.max(parseInt(req.query.limit, 10) || 10, 1),
      30,
    );
    // Cursor from the previous page's last result: its score + _id.
    const cursorScore =
      req.query.afterScore !== undefined
        ? parseFloat(req.query.afterScore)
        : null;
    const cursorId = req.query.afterId || null;
    const hasCursor = cursorScore !== null && cursorId && !Number.isNaN(cursorScore);

    // Filters (from user / date range / has-media / min-likes) can
    // stand alone or combine with a text query — an empty query with at
    // least one filter is still a valid search ("just show me @sam's
    // posts with media"), so only bail out when there's truly nothing
    // to search on.
    const { fromUserId, startDate, endDate, hasMedia, minLikes } =
      await parseSearchFilters(req.query);
    const hasFilters =
      fromUserId || startDate || endDate || hasMedia !== null || minLikes !== null;

    if (query.length > 0 && query.length < 2) {
      return res.status(200).json({ posts: [], hasMore: false });
    }
    if (query.length === 0 && !hasFilters) {
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
    // `user` gets built separately rather than spread twice: a plain
    // block-exclusion ($nin) and an exact from-user match ($eq via a
    // bare ObjectId) both target the same `user` key, so the later
    // spread would otherwise silently clobber the earlier one instead
    // of combining them. Explicit "user searched for X and X isn't
    // blocked" -> impossible-id filter, same as the unknown-username
    // case in parseSearchFilters, so it correctly returns zero results
    // rather than falling back to "any non-blocked user".
    const userFilter = fromUserId
      ? blockedIds.has(fromUserId.toString?.() ?? fromUserId)
        ? { user: "000000000000000000000000" }
        : { user: fromUserId }
      : blockedIds.size
        ? { user: { $nin: [...blockedIds] } }
        : {};
    const filter = {
      ...(query.length >= 2 ? { $text: { $search: query } } : {}),
      removedAt: null, // moderator soft-takedown — see reportService
      // Content search is a global discovery surface — public posts
      // only (and results can't vary by the searcher's follow graph).
      ...PUBLIC_ONLY_FILTER,
      ...userFilter,
      ...dateRangeFilter(startDate, endDate),
      ...hasMediaFilter(hasMedia),
      ...(minLikes !== null ? { likesCount: { $gte: minLikes } } : {}),
    };

    // Mongo can't apply a $lt/$or filter against the $meta-projected
    // score inside the same find() (meta projection is evaluated after
    // the query stage runs), so the compound (score, _id) cursor is
    // applied in-memory against a capped candidate set instead. $text +
    // the block filter already narrows results sharply for real queries,
    // so MAX_SEARCH_CANDIDATES bounds worst-case work without a second
    // round-trip; if it's ever hit, the result silently truncates rather
    // than paginating past it — acceptable since search result sets this
    // deep are not a realistic user journey.
    const MAX_SEARCH_CANDIDATES = 500;
    // Filters-only search (no $text) has no textScore to sort/project
    // by — falls back to newest-first, same convention as every other
    // non-ranked listing (feed/hashtag/bookmarks).
    const hasTextQuery = query.length >= 2;
    const candidates = await Post.find(
      filter,
      hasTextQuery ? { score: { $meta: "textScore" } } : {},
    )
      .populate("user", "name username profilePic")
      .populate({
        path: "quoteOf",
        populate: { path: "user", select: "name username profilePic" },
      })
      .sort(hasTextQuery ? { score: { $meta: "textScore" }, _id: -1 } : { createdAt: -1, _id: -1 })
      .limit(MAX_SEARCH_CANDIDATES);

    // Filters-only pagination cursors on (createdAt, _id) instead of
    // (score, _id) — mirrors getFeedPosts/getPostsByHashtag's plain
    // time cursor since there's no textScore to rank by here.
    const filtered = hasCursor
      ? candidates.filter((p) => {
          if (hasTextQuery) {
            const s = p._doc.score;
            if (s < cursorScore) return true;
            if (s === cursorScore) return p._id.toString() < cursorId;
            return false;
          }
          const t = p.createdAt.getTime();
          if (t < cursorScore) return true;
          if (t === cursorScore) return p._id.toString() < cursorId;
          return false;
        })
      : candidates;

    const hasMore = filtered.length > limit;
    const posts = hasMore ? filtered.slice(0, limit) : filtered;

    const postIds = posts.map((p) => p._id);
    const quoteOfIds = posts.filter((p) => p.quoteOf).map((p) => p.quoteOf._id);
    const allIds = [...postIds, ...quoteOfIds];
    const [likedPostIds, bookmarkedPostIds, repostedPostIds, reactionSummaries, myReactions] = await Promise.all([
      getLikedPostIds(req.user._id, allIds),
      getBookmarkedPostIds(req.user._id, allIds),
      getRepostedPostIds(req.user._id, allIds),
      getReactionSummaries('post', allIds),
      getUserReactions(req.user._id, 'post', allIds),
    ]);

    const formatQuoteOf = (quoteOfDoc) => ({
      ...quoteOfDoc._doc,
      isLiked: likedPostIds.has(quoteOfDoc._id.toString()),
      isBookmarked: bookmarkedPostIds.has(quoteOfDoc._id.toString()),
      isReposted: repostedPostIds.has(quoteOfDoc._id.toString()),
      reactionSummary: reactionSummaries.get(quoteOfDoc._id.toString()) || {},
      myReaction: myReactions.get(quoteOfDoc._id.toString()) || null,
    });

    const formattedPosts = posts.map((post) => ({
      ...post._doc,
      isLiked: likedPostIds.has(post._id.toString()),
      isBookmarked: bookmarkedPostIds.has(post._id.toString()),
      isReposted: repostedPostIds.has(post._id.toString()),
      isQuotePost: Boolean(post.quoteOf),
      quoteOf: post.quoteOf ? formatQuoteOf(post.quoteOf) : null,
      reactionSummary: reactionSummaries.get(post._id.toString()) || {},
      myReaction: myReactions.get(post._id.toString()) || null,
    }));

    res.status(200).json({
      posts: formattedPosts,
      hasMore,
      nextCursor: hasMore
        ? {
            afterScore: hasTextQuery
              ? posts[posts.length - 1]._doc.score
              : posts[posts.length - 1].createdAt.getTime(),
            afterId: posts[posts.length - 1]._id,
          }
        : null,
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

    // Privacy gate — a hidden post (only-me, or followers-only to a
    // non-follower) is indistinguishable from a missing one at this layer,
    // so direct-ID access can't probe for private posts.
    if (!(await canViewPost(userId, post))) {
      return res.status(404).json({ message: "Post not found" });
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

    // Fairness fix #2 — fire-and-forget, after the response so it never
    // adds latency to the like action itself. Only checked on the
    // "like" branch (liked === true): an unlike can only reduce
    // engagement, never trigger the implausible-velocity pattern this
    // guards against. See services/engagementVelocityService.js.
    if (liked) {
      checkEngagementVelocity(post).catch((err) =>
        console.error("Velocity check error:", err),
      );
    }
  } catch (error) {
    res.status(500).json({
      message: error.message,
    });
  }
};

// REACT TO POST — set/change/remove an emoji reaction. Separate from
// likePost (kept as-is, since a "like" is still the fast single-tap
// action) — this is the long-press/hover reaction bar. Sending the same
// emoji the user already has toggles it off; sending a different emoji
// switches it; body.emoji omitted/null removes it outright.
export const reactToPost = async (req, res) => {
  try {
    const post = await Post.findById(req.params.id);
    if (!post) {
      return res.status(404).json({ message: "Post not found" });
    }

    const userId = req.user._id;
    const { emoji } = req.body;

    if (
      post.user.toString() !== userId.toString() &&
      (await isBlockedEitherWay(userId, post.user))
    ) {
      return res
        .status(403)
        .json({ message: "You can't interact with this post." });
    }

    if (!(await canViewPost(userId, post))) {
      return res.status(404).json({ message: "Post not found" });
    }

    if (emoji && !REACTION_EMOJIS.includes(emoji)) {
      return res.status(400).json({ message: "Invalid reaction emoji" });
    }

    const current = await getUserReaction(userId, "post", post._id);
    let myReaction;

    if (!emoji || current === emoji) {
      // Same emoji tapped again, or an explicit clear -> remove.
      await removeReaction(userId, "post", post._id);
      myReaction = null;
    } else {
      await setReaction(userId, "post", post._id, emoji);
      myReaction = emoji;

      // Notify only on a genuinely new reaction (not a switch from one
      // emoji to another) — mirrors likePost's "don't notify yourself /
      // a muted-you author" gate, but only fires when there was no
      // previous reaction to avoid re-notifying on every emoji change.
      if (
        !current &&
        post.user.toString() !== userId.toString() &&
        !(await hasMuted(post.user, userId))
      ) {
        try {
          const newNotif = await Notification.create({
            recipient: post.user,
            sender: userId,
            type: "reaction",
            post: post._id,
            message: emoji,
          });
          const populatedNotif = await newNotif.populate(
            "sender",
            "name profilePic",
          );
          emitToUser(post.user, "newNotification", populatedNotif);
        } catch (socketError) {
          console.error("Reaction notification error:", socketError);
        }
      }
    }

    const summary = await getReactionSummary("post", post._id);

    try {
      io.to(`post_${post._id}`).emit("reactionUpdate", {
        postId: post._id,
        summary,
        userId: userId.toString(),
        emoji: myReaction,
      });
    } catch (socketError) {
      console.error("Reaction emission error:", socketError);
    }

    res.status(200).json({ summary, myReaction });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// TOGGLE BOOKMARK (save/unsave)
export const toggleBookmark = async (req, res) => {
  try {
    const post = await Post.findById(req.params.id).select("_id user privacy");
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

    // Privacy gate — same rationale as likePost: hidden posts look
    // missing to outsiders.
    if (!(await canViewPost(userId, post))) {
      return res.status(404).json({ message: "Post not found" });
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

    const quoteOfIds = posts.filter((p) => p.quoteOf).map((p) => p.quoteOf._id);
    const allIds = [...posts.map((p) => p._id), ...quoteOfIds];

    const [likedPostIds, bookmarkedPostIds, repostedPostIds, reactionSummaries, myReactions] = await Promise.all([
      getLikedPostIds(req.user._id, allIds),
      getBookmarkedPostIds(req.user._id, allIds),
      getRepostedPostIds(req.user._id, allIds),
      getReactionSummaries('post', allIds),
      getUserReactions(req.user._id, 'post', allIds),
    ]);

    const formatQuoteOf = (quoteOfDoc) => ({
      ...quoteOfDoc._doc,
      isLiked: likedPostIds.has(quoteOfDoc._id.toString()),
      isBookmarked: bookmarkedPostIds.has(quoteOfDoc._id.toString()),
      isReposted: repostedPostIds.has(quoteOfDoc._id.toString()),
      reactionSummary: reactionSummaries.get(quoteOfDoc._id.toString()) || {},
      myReaction: myReactions.get(quoteOfDoc._id.toString()) || null,
    });

    const formattedPosts = posts.map((post) => ({
      ...post._doc,
      isLiked: likedPostIds.has(post._id.toString()),
      isBookmarked: true,
      isReposted: repostedPostIds.has(post._id.toString()),
      isQuotePost: Boolean(post.quoteOf),
      quoteOf: post.quoteOf ? formatQuoteOf(post.quoteOf) : null,
      reactionSummary: reactionSummaries.get(post._id.toString()) || {},
      myReaction: myReactions.get(post._id.toString()) || null,
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

// TOGGLE REPOST (plain repost — no added text)
//
// Mirrors likePost's shape (read-then-act, race safety from the
// Repost collection's unique {user, post} index) but with an extra
// gate: only PUBLIC posts are repostable at all (see isRepostable's
// comment) — reposting a followers-only/only-me post would leak it to
// an audience the original author never granted visibility to. Works
// identically whether `post` is an ordinary post or a quote post
// (quotes are real Posts and are always public — see createQuotePost)
// — reposting a quote reposts the quote itself, not the post it
// embeds.
export const toggleRepost = async (req, res) => {
  try {
    const post = await Post.findById(req.params.id);
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

    if (!(await canViewPost(userId, post))) {
      return res.status(404).json({ message: "Post not found" });
    }

    const alreadyReposted = await hasReposted(userId, post._id);
    let reposted;

    if (alreadyReposted) {
      const removed = await removeRepostEdge(userId, post._id);
      reposted = false;
      if (removed) {
        post.repostsCount = Math.max(0, post.repostsCount - 1);
        await post.updateOne({ $inc: { repostsCount: -1 } });
        await Notification.deleteOne({
          recipient: post.user,
          sender: userId,
          type: "repost",
          post: post._id,
        });
      }
    } else {
      // Reposting is inherently a fan-out-to-my-followers action, so
      // (unlike liking) it's gated on the post's audience, not just
      // whether THIS viewer can currently see it — a follower of the
      // author reposting a followers-only post could otherwise leak it
      // to their own followers who never had access.
      if (!isRepostable(post)) {
        return res
          .status(403)
          .json({ message: "This post can't be reposted." });
      }

      const created = await createRepostEdge(userId, post._id);
      reposted = true;
      if (created) {
        post.repostsCount += 1;
        await post.updateOne({ $inc: { repostsCount: 1 } });

        if (
          post.user.toString() !== userId.toString() &&
          !(await hasMuted(post.user, userId))
        ) {
          const newNotif = await Notification.create({
            recipient: post.user,
            sender: userId,
            type: "repost",
            post: post._id,
          });
          try {
            const populatedNotif = await newNotif.populate(
              "sender",
              "name username profilePic",
            );
            emitToUser(post.user, "newNotification", populatedNotif);
          } catch (socketError) {
            console.error("Repost notification real-time error:", socketError);
          }
        }
      }
    }

    // Reposting changes what shows up in the reposter's followers'
    // feeds, so their caches need invalidating too — not just the
    // reposter's own (mirrors createPost's invalidateFeedCache call).
    invalidateFeedCache(userId);
    invalidateCache(`profile-posts:${userId}:*`);

    try {
      io.to(`post_${post._id}`).emit("repostUpdate", {
        postId: post._id,
        repostsCount: post.repostsCount,
        userId: userId.toString(),
        reposted,
      });
    } catch (socketError) {
      console.error("Repost count emission error:", socketError);
    }

    res.status(200).json({
      reposts: post.repostsCount,
      reposted,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// CREATE QUOTE POST — a real, independently-authored Post that embeds
// the original via `quoteOf`. A quote is a genuine Post document (not
// a synthetic Repost edge), so it automatically gets its own likes,
// comments, bookmarks, and reposts through every existing post-scoped
// route — no special-casing needed anywhere else. Quoting a quote is
// rejected: only one level of embedding is allowed, so the embed
// target is always a "real" original, never another quote wrapper.
export const createQuotePost = async (req, res) => {
  try {
    const original = await Post.findById(req.params.id);
    if (!original) {
      return res.status(404).json({ message: "Post not found" });
    }

    const userId = req.user._id;

    if (
      original.user.toString() !== userId.toString() &&
      (await isBlockedEitherWay(userId, original.user))
    ) {
      return res
        .status(403)
        .json({ message: "You can't interact with this post." });
    }

    if (!(await canViewPost(userId, original))) {
      return res.status(404).json({ message: "Post not found" });
    }

    if (!isRepostable(original)) {
      return res.status(403).json({ message: "This post can't be quoted." });
    }

    // One level of embedding only — quoting a quote isn't allowed.
    if (original.quoteOf) {
      return res
        .status(403)
        .json({ message: "You can't quote a quote. Quote the original post instead." });
    }

    const { text } = req.body;
    const hashtags = extractHashtags(text);

    const quotePost = await Post.create({
      user: userId,
      text,
      hashtags,
      privacy: POST_PRIVACY.PUBLIC, // a quote is always public — see createQuoteSchema
      quoteOf: original._id,
    });

    original.repostsCount += 1;
    await original.updateOne({ $inc: { repostsCount: 1 } });

    const populatedQuote = await quotePost.populate("user", "name username profilePic");
    const populatedOriginal = await original.populate("user", "name username profilePic");

    // Notify the original author (skip self-quotes, blocked, muted —
    // same guards as every other notification path here).
    try {
      if (
        original.user.toString() !== userId.toString() &&
        !(await hasMuted(original.user, userId))
      ) {
        const newNotif = await Notification.create({
          recipient: original.user,
          sender: userId,
          // A quote is its own thing, not a repost — the recipient's
          // notifications page renders "X quoted your post" from this.
          type: "quote",
          post: original._id,
        });
        const populatedNotif = await newNotif.populate(
          "sender",
          "name username profilePic",
        );
        emitToUser(original.user, "newNotification", populatedNotif);
      }
    } catch (notifError) {
      console.error("Quote notification error:", notifError.message);
    }

    // Notify mentioned users in the quote's own text — same pattern as
    // createPost.
    try {
      const mentionedUsernames = extractMentions(text);
      if (mentionedUsernames.length) {
        const mentionedUsers = await User.find({
          username: { $in: mentionedUsernames },
          _id: { $ne: userId },
        }).select("_id");
        const blockedIds = await getBlockedEitherWayIds(userId);
        await Promise.all(
          mentionedUsers
            .filter((u) => !blockedIds.has(u._id.toString()))
            .map(async (mentionedUser) => {
              if (await hasMuted(mentionedUser._id, userId)) return;
              const newNotif = await Notification.create({
                recipient: mentionedUser._id,
                sender: userId,
                type: "mention",
                post: quotePost._id,
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
      console.error("Quote mention notification error:", mentionError.message);
    }

    invalidateFeedCache(userId);
    invalidateCache(`profile-posts:${userId}:*`);

    const responseBody = {
      ...populatedQuote._doc,
      isQuotePost: true,
      isLiked: false,
      isBookmarked: false,
      isReposted: false,
      quoteOf: {
        ...populatedOriginal._doc,
        isLiked: false,
        isBookmarked: false,
        isReposted: false,
      },
      repostedBy: null,
    };

    res.status(201).json(responseBody);

    try {
      if (original.privacy !== POST_PRIVACY.ONLY_ME) {
        emitToFollowersOf(userId, "newPost", responseBody);
      }
    } catch (socketError) {
      console.error("Quote real-time feed emission error:", socketError);
    }
  } catch (error) {
    console.error("CREATE QUOTE POST ERROR:", error.message);
    res.status(500).json({ message: error.message });
  }
};

// GET SINGLE POST BY ID — used by the frontend to open a post's own
// detail modal from an indirect reference (currently: clicking the
// embedded original inside a quote card/modal, where the quote only
// carries a possibly-stale snapshot of the original at quote time).
// Same visibility rules as every other direct-ID route: block check +
// canViewPost, so this can't be used to probe for hidden posts.
export const getPostById = async (req, res) => {
  try {
    const post = await Post.findOne({
      _id: req.params.id,
      removedAt: null,
    })
      .populate("user", "name username profilePic")
      .populate({
        path: "quoteOf",
        populate: { path: "user", select: "name username profilePic" },
      });

    if (!post) {
      return res.status(404).json({ message: "Post not found" });
    }

    const userId = req.user._id;

    if (
      post.user._id.toString() !== userId.toString() &&
      (await isBlockedEitherWay(userId, post.user._id))
    ) {
      return res.status(404).json({ message: "Post not found" });
    }

    if (!(await canViewPost(userId, post))) {
      return res.status(404).json({ message: "Post not found" });
    }

    const idsToCheck = [post._id, ...(post.quoteOf ? [post.quoteOf._id] : [])];
    const [likedPostIds, bookmarkedPostIds, repostedPostIds, reactionSummaries, myReactions] = await Promise.all([
      getLikedPostIds(userId, idsToCheck),
      getBookmarkedPostIds(userId, idsToCheck),
      getRepostedPostIds(userId, idsToCheck),
      getReactionSummaries("post", idsToCheck),
      getUserReactions(userId, "post", idsToCheck),
    ]);

    const formatted = {
      ...post._doc,
      isLiked: likedPostIds.has(post._id.toString()),
      isBookmarked: bookmarkedPostIds.has(post._id.toString()),
      isReposted: repostedPostIds.has(post._id.toString()),
      isQuotePost: Boolean(post.quoteOf),
      reactionSummary: reactionSummaries.get(post._id.toString()) || {},
      myReaction: myReactions.get(post._id.toString()) || null,
      quoteOf: post.quoteOf
        ? {
            ...post.quoteOf._doc,
            isLiked: likedPostIds.has(post.quoteOf._id.toString()),
            isBookmarked: bookmarkedPostIds.has(post.quoteOf._id.toString()),
            isReposted: repostedPostIds.has(post.quoteOf._id.toString()),
            reactionSummary: reactionSummaries.get(post.quoteOf._id.toString()) || {},
            myReaction: myReactions.get(post.quoteOf._id.toString()) || null,
          }
        : null,
    };

    res.status(200).json(formatted);
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

    // Delete Cloudinary image(s) safely — deleted in parallel and
    // independently so one failure doesn't block the others.
    const urlsToDelete = post.images || [];
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

    // Delete related likes/bookmarks/reposts for THIS post — otherwise
    // these edges would stay orphaned, referencing a post that no
    // longer exists.
    await removeAllLikesForPost(post._id);
    await removeAllBookmarksForPost(post._id);
    await removeAllRepostsForPost(post._id);
    await removeAllReactionsForTarget("post", post._id);

    // Quotes of this post are NOT cascade-deleted — a quote is a real,
    // independently-authored Post with its own likes/comments/
    // bookmarks/reposts (see models/Post.js's quoteOf), so it has
    // meaning independent of the original the same way a reply keeps
    // meaning after its parent is gone. Any quote's `quoteOf` populate
    // will simply come back empty once this post is gone;
    // QuotedPostPreview already renders that as "This post is no
    // longer available." — no cascade needed here.
    await post.deleteOne();

    // Invalidate feed cache
    invalidateFeedCache(req.user._id);
    invalidateCache(`profile-posts:${req.user._id}:*`);

    res.status(200).json({ message: "Post deleted" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
