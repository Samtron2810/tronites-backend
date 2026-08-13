// Shared text parsing for hashtags (#tag) and mentions (@username).
// Used by both posts and comments so the rules stay identical everywhere.

const HASHTAG_RE = /#([a-zA-Z0-9_]{1,50})/g;
const MENTION_RE = /@([a-z0-9_]{3,20})/gi;

// Extract unique, lowercased hashtags from text (without the #).
export const extractHashtags = (text = "") => {
  const tags = new Set();
  for (const match of text.matchAll(HASHTAG_RE)) {
    tags.add(match[1].toLowerCase());
  }
  return [...tags];
};

// Extract unique, lowercased usernames mentioned in text (without the @).
export const extractMentions = (text = "") => {
  const mentions = new Set();
  for (const match of text.matchAll(MENTION_RE)) {
    mentions.add(match[1].toLowerCase());
  }
  return [...mentions];
};
