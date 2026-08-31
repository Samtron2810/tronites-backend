import User from "../models/User.js";

// Shared "from user / date range / has media / min likes" filter
// parsing for the three content-search endpoints (posts, comments,
// messages). Centralized here so all three interpret the same query
// params the same way, instead of each controller re-deriving its own
// slightly-different date/number parsing.
//
// Returns { fromUserId, startDate, endDate, hasMedia, minLikes } — any
// field the caller didn't ask for (or that failed to resolve, e.g. an
// unknown username) comes back null and should simply be omitted from
// the Mongo filter by the caller.
export const parseSearchFilters = async (query) => {
  const fromUsername = String(query.from || "").trim().replace(/^@/, "").toLowerCase();
  let fromUserId = null;
  if (fromUsername) {
    const fromUser = await User.findOne({ username: fromUsername }).select("_id");
    // Unknown username -> impossible id sentinel rather than dropping
    // the filter, so "from a user that doesn't exist" correctly returns
    // zero results instead of silently ignoring the filter and
    // returning everyone's results.
    fromUserId = fromUser ? fromUser._id : "000000000000000000000000";
  }

  const parseDate = (val) => {
    if (!val) return null;
    const d = new Date(val);
    return Number.isNaN(d.getTime()) ? null : d;
  };
  const startDate = parseDate(query.startDate);
  let endDate = parseDate(query.endDate);
  // Inclusive end-of-day: a bare "2026-08-31" date input means "through
  // the end of Aug 31", not midnight at its start.
  if (endDate) endDate = new Date(endDate.getTime() + 24 * 60 * 60 * 1000 - 1);

  const hasMedia =
    query.hasMedia === "true" ? true : query.hasMedia === "false" ? false : null;

  const minLikesNum = parseInt(query.minLikes, 10);
  const minLikes = Number.isFinite(minLikesNum) && minLikesNum > 0 ? minLikesNum : null;

  return { fromUserId, startDate, endDate, hasMedia, minLikes };
};

// Mongo filter fragment for createdAt range — omits keys entirely when
// unset so it can be spread into a larger filter without clobbering an
// unrelated createdAt condition the caller already has.
export const dateRangeFilter = (startDate, endDate) => {
  if (!startDate && !endDate) return {};
  const createdAt = {};
  if (startDate) createdAt.$gte = startDate;
  if (endDate) createdAt.$lte = endDate;
  return { createdAt };
};

// Mongo filter fragment: post/message has at least one image or a video.
export const hasMediaFilter = (hasMedia) => {
  if (hasMedia === null) return {};
  if (hasMedia === true) {
    return {
      $or: [{ "images.0": { $exists: true } }, { "video.url": { $ne: null } }],
    };
  }
  return {
    $and: [{ images: { $size: 0 } }, { "video.url": null }],
  };
};
