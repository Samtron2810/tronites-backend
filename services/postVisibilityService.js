import { isFollowing } from "./followService.js";
import { CreatorSubscription } from "../models/CreatorSubscription.js";

// Single source of truth for post privacy ("who can see this post").
//
// Values are stored on the Post document (`privacy` field, default
// "public"). Every user-facing read path goes through the helper
// filters below so a followers-only / only-me post can never leak into
// a surface that shouldn't show it, and direct-ID actions (like /
// comment / bookmark) are re-checked with canViewPost as a second line
// of defense.
//
// Legacy posts created before this feature shipped have the field
// missing entirely — mongoose's default only applies when building new
// documents, so stored rows can legitimately lack `privacy`. All the
// Mongo fragments below treat "missing" exactly like "public" via
// `$exists: false`, so no migration is required for correctness.
// Mongo filter fragment: posts that have been published (not waiting for
// a scheduled publish time). Add this to every feed/discovery query so
// scheduled posts are invisible until the cron job publishes them.
export const PUBLISHED_FILTER = { scheduledFor: null };

export const POST_PRIVACY = Object.freeze({
  PUBLIC: "public",
  FOLLOWERS: "followers",
  SUBSCRIBERS: "subscribers",
  ONLY_ME: "only-me",
});

export const POST_PRIVACY_VALUES = Object.values(POST_PRIVACY);

// Mongo filter fragment: posts visible to EVERYONE regardless of who's
// asking. Used by the shared-cache discovery surfaces (trending,
// hashtag pages, search) whose result sets must not depend on the
// viewer — including the author, since these surfaces are global.
// Subscriber-only posts are excluded from discovery (they're paywalled).
export const PUBLIC_ONLY_FILTER = {
  $or: [{ privacy: POST_PRIVACY.PUBLIC }, { privacy: { $exists: false } }],
};

// Mongo filter fragment: posts visible to the author's followers
// (author + followers, i.e. everything except only-me and subscribers).
// Used by the followers tier of the profile-posts read.
// NOTE: subscriber-only posts are NOT included here — following does not
// grant subscriber access. They surface separately via the subscriber check.
export const FOLLOWERS_VISIBLE_FILTER = {
  $or: [
    { privacy: POST_PRIVACY.PUBLIC },
    { privacy: POST_PRIVACY.FOLLOWERS },
    { privacy: { $exists: false } },
  ],
};

// Mongo filter fragment for the personalized following feed. The feed
// already only contains posts from followed accounts + the viewer, so
// the only posts needing exclusion are OTHER people's only-me and
// subscriber-only ones — your own posts of any privacy always appear.
export const feedVisibilityFilter = (viewerId) => ({
  $or: [
    { user: viewerId },
    { privacy: { $nin: [POST_PRIVACY.ONLY_ME, POST_PRIVACY.SUBSCRIBERS] } },
  ],
});

// Can this post be reposted/quoted at all, by anyone other than its
// own author? Subscriber-only and followers-only posts are not repostable —
// same reasoning as followers: the reposter's audience never opted in.
export const isRepostable = (post) => {
  const privacy = post.privacy || POST_PRIVACY.PUBLIC;
  return privacy === POST_PRIVACY.PUBLIC;
};

// Checks if viewerId has an active, non-expired subscription to creatorId.
// Thin async helper used by canViewPost and checkSubscriberAccess.
export const isActiveSubscriber = async (viewerId, creatorId) => {
  if (!viewerId) return false;
  const sub = await CreatorSubscription.findOne({
    subscriber: viewerId,
    creator: creatorId,
    status: "active",
    currentPeriodEnd: { $gt: new Date() },
  })
    .select("_id")
    .lean();
  return !!sub;
};

// Can `viewerId` see `post` directly? Used as defense-in-depth on
// direct-ID actions (like / comment / bookmark) where a post could
// theoretically be reachable even if no listing surface shows it. The
// post's author always passes; everyone else is tiered by privacy.
export const canViewPost = async (viewerId, post) => {
  if (!post) return false;
  if (post.user.toString() === viewerId.toString()) return true;

  const privacy = post.privacy || POST_PRIVACY.PUBLIC;
  if (privacy === POST_PRIVACY.PUBLIC) return true;
  if (privacy === POST_PRIVACY.ONLY_ME) return false;

  // subscribers-only: must have an active paid subscription.
  if (privacy === POST_PRIVACY.SUBSCRIBERS) {
    return isActiveSubscriber(viewerId, post.user);
  }

  // followers-only: the viewer must be following the author.
  return isFollowing(viewerId, post.user);
};
