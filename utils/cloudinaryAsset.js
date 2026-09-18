// Cloudinary public-ID extraction for images referenced by URL.
//
// Why this exists: Post.images entries are { url, altText } subdocuments
// (models/Post.js) and legacy posts may still hold plain URL strings,
// while Message.images entries are strings. Callers that handed the entry
// straight to `.split()` therefore broke the moment the stored shape
// changed — `url.split is not a function` on an object — which silently
// skipped every Cloudinary destroy in the best-effort cleanup paths. Accept
// both shapes in one place instead of re-deriving the public ID per caller.

// Returns the folder-less public-ID leaf, or null.
//
// "Folder-less" because every caller knows its own fixed folder
// (tronites_posts / tronites_messages / tronites_profiles) and prefixes it,
// matching how the signed-upload endpoints pin the folder. Any
// transformation/version path segments are discarded, and the extension and
// query/hash are stripped, so all of these yield "abc123":
//
//   .../upload/tronites_posts/abc123.jpg
//   .../upload/v1699999999/tronites_posts/abc123.jpg
//   .../upload/w_1600,h_1600,c_limit,q_auto,f_auto/v1699999999/tronites_posts/abc123.jpg
//   .../upload/tronites_posts/abc123.jpg?_a=BAM
//
// Never throws: one malformed entry must not abort a batch of best-effort
// cleanups, so callers can safely skip a null result.
export const publicIdFromImageUrl = (image) => {
  const url = typeof image === "string" ? image : image?.url;
  if (typeof url !== "string") return null;

  const path = url.split(/[?#]/)[0];
  const leaf = path.split("/").filter(Boolean).pop();
  if (!leaf) return null;

  // lastIndexOf (not split(".")[0]) so a public ID that itself contains a
  // dot — "my.photo.jpg" -> "my.photo" — keeps its inner dots.
  const dot = leaf.lastIndexOf(".");
  return (dot > 0 ? leaf.slice(0, dot) : leaf) || null;
};