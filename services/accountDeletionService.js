import User from "../models/User.js";
import Post from "../models/Post.js";
import Comment from "../models/Comment.js";
import Notification from "../models/Notification.js";
import Message from "../models/Message.js";
import Conversation from "../models/Conversation.js";
import Report from "../models/Report.js";
import Session from "../models/Session.js";
import cloudinary from "../utils/cloudinary.js";
import { invalidateFeedCache, invalidateCache } from "../utils/redis.js";
import { removeAllLikesForPost, removeAllLikesForUser } from "./likeService.js";
import { removeAllBookmarksForPost, removeAllBookmarksForUser } from "./bookmarkService.js";
import { removeAllRepostsForPost, removeAllRepostsForUser } from "./repostService.js";
import { removeAllCommentLikesForUser } from "./commentLikeService.js";
import {
  removeAllReactionsForTargets,
  removeAllReactionsForUser,
} from "./reactionService.js";
import { removeAllFollowEdgesForUser } from "./followService.js";
import { removeAllMuteEdgesForUser } from "./muteService.js";
import { removeAllBlockEdgesForUser } from "./blockService.js";
import { revokeAllSessions } from "../utils/tokens.js";

// Grace window between a user confirming deletion (soft-delete,
// immediate) and the purge job hard-deleting the account and cascading
// through every collection that references it. Gives support a window
// to reverse an accidental or coerced deletion before it's permanent.
export const DELETION_GRACE_PERIOD_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// STEP 1 of 2 — soft delete. Called directly from the account-deletion
// endpoint. Makes the account unusable immediately (authMiddleware and
// loginUser both check deletedAt) without touching any other
// collection yet — the actual cascade is deliberately deferred to the
// purge job below so a mistaken or coerced deletion can still be
// reversed by support within the grace window, by just clearing
// deletedAt back to null.
export const softDeleteAccount = async (userId) => {
  await User.updateOne({ _id: userId }, { $set: { deletedAt: new Date() } });
  // Kill every active session immediately — a soft-deleted account
  // shouldn't stay logged in on other devices just because the purge
  // hasn't run yet.
  await revokeAllSessions(userId);
};

const destroyCloudinaryAsset = async (publicId, resourceType = "image") => {
  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
  } catch (err) {
    // Best-effort — an orphaned Cloudinary asset is a cleanup task, not
    // a reason to abort deleting the account's data.
    console.log("Cloudinary delete failed during account purge:", err.message);
  }
};

const publicIdFromUrl = (url) => {
  try {
    return url.split("/").slice(-1)[0].split(".")[0];
  } catch {
    return null;
  }
};

// STEP 2 of 2 — hard delete + full cascade. Called by
// jobs/purgeDeletedAccounts.js once deletedAt is older than
// DELETION_GRACE_PERIOD_MS. This is the point of no return: irreversible,
// so it's kept as its own explicit function rather than folded into
// softDeleteAccount, and the purge job (not this function) is what
// decides *when* it's safe to call.
export const hardDeleteAccount = async (userId) => {
  const user = await User.findById(userId);
  if (!user) return; // already purged, or never existed — no-op

  // ── Posts: delete each one's media from Cloudinary, then the posts
  // themselves, then everything that referenced those specific posts
  // (comments, likes, bookmarks — mirrors deletePost's own cascade so
  // this doesn't leave a different set of orphans than a manual
  // per-post delete would).
  const posts = await Post.find({ user: userId }).select(
    "_id images video",
  );

  for (const post of posts) {
    await Promise.all(
      (post.images || []).map(async (url) => {
        const publicId = publicIdFromUrl(url);
        if (publicId) await destroyCloudinaryAsset(`tronites_posts/${publicId}`);
      }),
    );
    if (post.video?.publicId) {
      await destroyCloudinaryAsset(post.video.publicId, "video");
    }
  }

  const postIds = posts.map((p) => p._id);
  if (postIds.length) {
    await Comment.deleteMany({ post: { $in: postIds } });
    await Promise.all(postIds.map((id) => removeAllLikesForPost(id)));
    await Promise.all(postIds.map((id) => removeAllBookmarksForPost(id)));
    await Promise.all(postIds.map((id) => removeAllRepostsForPost(id)));
    await removeAllReactionsForTargets("post", postIds);
    await Post.deleteMany({ _id: { $in: postIds } });
  }

  // ── This user's own comments on OTHER users' posts. Deleting these
  // outright (rather than anonymizing) matches how deleteComment already
  // behaves — a comment has no meaning divorced from its author the way
  // a Report might. Reply-children of a deleted top-level comment are
  // orphaned by this (parentComment points nowhere) — same tradeoff
  // deleteComment's single-level cascade already accepts, not something
  // this cascade needs to solve differently.
  await Comment.deleteMany({ user: userId });

  // ── Edges this user is party to, in any direction.
  await removeAllLikesForUser(userId);
  await removeAllBookmarksForUser(userId);
  await removeAllCommentLikesForUser(userId);
  await removeAllRepostsForUser(userId);
  await removeAllFollowEdgesForUser(userId);
  await removeAllMuteEdgesForUser(userId);
  await removeAllBlockEdgesForUser(userId);
  await removeAllReactionsForUser(userId);

  // ── Notifications: both directions (this user's own notification
  // feed, and any notification this user triggered for someone else).
  await Notification.deleteMany({
    $or: [{ recipient: userId }, { sender: userId }],
  });

  // ── Messages/Conversations: hard-deleted outright (no anonymization)
  // — a DM thread with a permanently-deleted party isn't meaningful to
  // preserve for the other participant the way, say, a public comment
  // thread might be, and there's no moderation-history argument for
  // keeping private message content the way there is for Reports below.
  // Cloudinary cleanup for message images: best-effort, since (per
  // messageController.js) nothing currently deletes these on individual
  // message deletion either — this is strictly better than the status
  // quo, not a promise of completeness elsewhere in the app.
  const messages = await Message.find({
    $or: [{ sender: userId }, { receiver: userId }],
  }).select("image");
  await Promise.all(
    messages
      .filter((m) => m.image)
      .map(async (m) => {
        const publicId = publicIdFromUrl(m.image);
        if (publicId) await destroyCloudinaryAsset(`tronites_messages/${publicId}`);
      }),
  );
  // Chat videos live in their own folder with a proper publicId (uploaded
  // directly to Cloudinary, not base64-through-Express like images), so
  // cleanup is a straight destroy call — same as post videos.
  const videoMessages = await Message.find({
    $or: [{ sender: userId }, { receiver: userId }],
    "video.publicId": { $ne: null },
  }).select("video.publicId");
  await Promise.all(
    videoMessages.map(async (m) => {
      if (m.video?.publicId) {
        await destroyCloudinaryAsset(m.video.publicId, "video");
      }
    }),
  );
  const allMessageIds = await Message.find({
    $or: [{ sender: userId }, { receiver: userId }],
  }).distinct("_id");
  await removeAllReactionsForTargets("message", allMessageIds);
  await Message.deleteMany({ $or: [{ sender: userId }, { receiver: userId }] });
  await Conversation.deleteMany({ participants: userId });

  // ── Reports: anonymize rather than delete. A report *against* this
  // user (targetOwner) is moderation history about conduct that may
  // involve other still-active users (repeat-offender patterns,
  // resolved-action audit trail) — deleting it outright erases that
  // history for no benefit to the deleted user, who's already gone
  // either way. A report this user *filed* (reporter) is evidence about
  // someone else's conduct, not this user's own data, so it's kept too.
  // Both directions have `resolvedBy` nulled out if it was this user
  // acting as a moderator. targetOwner reports for a *deleted* user's
  // own content are moot (the content is already gone above) but the
  // report row itself still documents that a report was made and how it
  // was resolved, which is the part worth keeping.
  await Report.updateMany(
    { reporter: userId },
    { $set: { reporter: null } },
  );
  await Report.updateMany(
    { resolvedBy: userId },
    { $set: { resolvedBy: null } },
  );
  // Reports specifically about this user's account (targetType: "user",
  // targetId: userId) no longer point at anything actionable — the
  // account is gone — so unlike the reporter/resolvedBy anonymization
  // above, these are deleted outright rather than kept as history about
  // a target that no longer exists to take further action against.
  await Report.deleteMany({ targetType: "user", targetId: userId });

  // ── Sessions: already revoked at soft-delete time, but a fresh
  // deleteMany here is cheap insurance against any session created in
  // the (very unlikely) gap between soft-delete and purge — e.g. a
  // support-assisted reactivation-then-re-deletion in the same window.
  await Session.deleteMany({ user: userId });

  // ── Profile picture.
  if (user.profilePic) {
    const publicId = publicIdFromUrl(user.profilePic);
    if (publicId) await destroyCloudinaryAsset(`tronites_profiles/${publicId}`);
  }

  await User.deleteOne({ _id: userId });

  // Best-effort cache cleanup — a stale entry here just means a
  // deleted user's ghost content could appear in someone's cache until
  // TTL expiry, not a correctness issue worth failing the purge over.
  try {
    invalidateFeedCache(userId);
    invalidateCache(`profile:${userId}:*`);
    invalidateCache(`profile-posts:${userId}:*`);
  } catch {
    // ignore — see comment above
  }
};
