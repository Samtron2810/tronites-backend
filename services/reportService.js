import Report from "../models/Report.js";
import Post from "../models/Post.js";
import Comment from "../models/Comment.js";

const httpError = (statusCode, message) => {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
};

// Creates a report. Idempotent per (reporter, targetType, targetId) via
// the schema's unique index — a second report of the same object by the
// same person updates the reason/details on the existing open report
// instead of creating a duplicate row that would just inflate the queue
// without adding signal. If the existing report was already resolved,
// a new report re-opens it — a fresh complaint against something a
// moderator previously dismissed is worth another look, not silently
// dropped.
export const createReport = async ({
  reporterId,
  targetType,
  targetId,
  targetOwner,
  reason,
  details,
}) => {
  if (targetOwner.toString() === reporterId.toString()) {
    throw httpError(400, "You can't report your own content.");
  }

  const existing = await Report.findOneAndUpdate(
    { reporter: reporterId, targetType, targetId },
    {
      $set: {
        targetOwner,
        reason,
        details: details || "",
        status: "open",
        resolvedBy: null,
        resolvedAt: null,
        resolutionNote: "",
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  return existing;
};

// Moderator queue — open reports first (oldest first within that, so
// nothing sits ignored), everything else after.
//
// Each report is enriched with just enough to build a "view content"
// link and give the moderator a preview without a second round-trip.
// The app has no standalone single-post or single-comment page — posts
// and comments only render inline within a profile/feed/hashtag list —
// so "jump to content" resolves to the author's profile
// (`/profile/:targetOwner`) for post/comment reports, and to the
// reported account's own profile for user reports. Message reports have
// no viewable surface at all (messages aren't listed anywhere by ID);
// those get contentPreview only, with linkable: false so the UI can
// show that plainly instead of a dead link.
export const listReports = async ({ status = "open", page = 1, limit = 25 } = {}) => {
  const skip = (page - 1) * limit;
  const filter = status === "all" ? {} : { status };

  const [reports, total] = await Promise.all([
    Report.find(filter)
      .sort({ status: 1, createdAt: 1 })
      .skip(skip)
      .limit(limit)
      .populate("reporter", "name username profilePic")
      .populate("targetOwner", "name username profilePic")
      .lean(),
    Report.countDocuments(filter),
  ]);

  const postIds = reports.filter((r) => r.targetType === "post").map((r) => r.targetId);
  const commentIds = reports.filter((r) => r.targetType === "comment").map((r) => r.targetId);

  const [posts, comments] = await Promise.all([
    postIds.length ? Post.find({ _id: { $in: postIds } }).select("text").lean() : [],
    commentIds.length ? Comment.find({ _id: { $in: commentIds } }).select("text").lean() : [],
  ]);
  const postById = new Map(posts.map((p) => [p._id.toString(), p]));
  const commentById = new Map(comments.map((c) => [c._id.toString(), c]));

  const enriched = reports.map((r) => {
    const targetIdStr = r.targetId.toString();
    if (r.targetType === "user") {
      return {
        ...r,
        contentPreview: null,
        linkable: true,
        linkTo: `/profile/${targetIdStr}`,
      };
    }
    if (r.targetType === "post") {
      const post = postById.get(targetIdStr);
      return {
        ...r,
        contentPreview: post ? post.text : "[post no longer exists]",
        linkable: Boolean(post),
        linkTo: `/profile/${r.targetOwner?._id || r.targetOwner}`,
      };
    }
    if (r.targetType === "comment") {
      const comment = commentById.get(targetIdStr);
      return {
        ...r,
        contentPreview: comment ? comment.text : "[comment no longer exists]",
        linkable: Boolean(comment),
        linkTo: `/profile/${r.targetOwner?._id || r.targetOwner}`,
      };
    }
    // message
    return {
      ...r,
      contentPreview: "Message content isn't viewable outside the conversation.",
      linkable: false,
      linkTo: null,
    };
  });

  return { reports: enriched, total, page, totalPages: Math.ceil(total / limit) };
};

export const resolveReport = async ({ reportId, moderatorId, status, note }) => {
  if (!["actioned", "dismissed"].includes(status)) {
    throw httpError(400, "status must be 'actioned' or 'dismissed'");
  }

  const report = await Report.findOneAndUpdate(
    { _id: reportId, status: "open" },
    {
      $set: {
        status,
        resolvedBy: moderatorId,
        resolvedAt: new Date(),
        resolutionNote: note || "",
      },
    },
    { new: true },
  );

  if (!report) {
    throw httpError(404, "Report not found or already resolved.");
  }

  return report;
};
