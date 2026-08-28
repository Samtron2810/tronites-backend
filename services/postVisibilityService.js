import { isFollowing } from "./followService.js";

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
export const POST_PRIVACY = Object.freeze({
  PUBLIC: "public",
  FOLLOWERS: "followers",
  ONLY_ME: "only-me",
});

export const POST_PRIVACY_VALUES = Object.values(POST_PRIVACY);

// Mongo filter fragment: posts visible to EVERYONE regardless of who's
// asking. Used by the shared-cache discovery surfaces (trending,
// hashtag pages, search) whose result sets must not depend on the
// viewer — including the author, since these surfaces are global.
export const PUBLIC_ONLY_FILTER = {
  $or: [{ privacy: POST_PRIVACY.PUBLIC }, { privacy: { $exists: false } }],
};

// Mongo filter fragment: posts visible to the author's followers
// (author + followers, i.e. everything except only-me). Used by the
// followers tier of the profile-posts read.
export const FOLLOWERS_VISIBLE_FILTER = {
  $or: [
    { privacy: POST_PRIVACY.PUBLIC },
    { privacy: POST_PRIVACY.FOLLOWERS },
    { privacy: { $exists: false } },
  ],
};

// Mongo filter fragment for the personalized following feed. The feed
// already only contains posts from followed accounts + the viewer, so
// the only posts needing exclusion are OTHER people's only-me ones —
// your own only-me posts still show up in your own feed. Combined with
// `user: { $in: feedUsers }` by the caller.
export const feedVisibilityFilter = (viewerId) => ({
  $or: [
    { user: viewerId },
    { privacy: { $ne: POST_PRIVACY.ONLY_ME } },
  ],
});

// Can this post be reposted/quoted at all, by anyone other than its
// own author? Reposting is inherently a "send this to MY followers"
// action — a followers-only or only-me post reposted verbatim would
// leak it to an audience the original author never chose (the
// reposter's followers, who may not follow the original author and so
// were never granted visibility in the first place). Public posts are
// the only ones eligible; this is independent of whether the specific
// viewer could currently see the post via canViewPost below.
export const isRepostable = (post) => {
  const privacy = post.privacy || POST_PRIVACY.PUBLIC;
  return privacy === POST_PRIVACY.PUBLIC;
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

  // followers-only: the viewer must be following the author.
  return isFollowing(viewerId, post.user);
};