import Report from "../models/Report.js";
import Post from "../models/Post.js";
import Comment from "../models/Comment.js";
import Message from "../models/Message.js";
import { invalidateCache, invalidateFeedCache } from "../utils/redis.js";

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
// Each report is enriched with a lightweight text preview so the
// moderator can triage without leaving the list. The full flagged item
// is NOT fetched here — the queue renders it on demand via
// getReportContext (GET /reports/:id/context), which powers the
// in-queue preview modal. User reports keep their profile deep-link
// (reporting a profile isn't a "find one item in a list" problem);
// post/comment/message reports no longer carry linkTo/linkable — the
// modal replaced that navigation pattern.
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
  const messageIds = reports.filter((r) => r.targetType === "message").map((r) => r.targetId);

  const [posts, comments, messages] = await Promise.all([
    postIds.length ? Post.find({ _id: { $in: postIds } }).select("text removedAt").lean() : [],
    commentIds.length ? Comment.find({ _id: { $in: commentIds } }).select("text removedAt").lean() : [],
    messageIds.length ? Message.find({ _id: { $in: messageIds } }).select("text removedAt").lean() : [],
  ]);
  const postById = new Map(posts.map((p) => [p._id.toString(), p]));
  const commentById = new Map(comments.map((c) => [c._id.toString(), c]));
  const messageById = new Map(messages.map((m) => [m._id.toString(), m]));

  const enriched = reports.map((r) => {
    const targetIdStr = r.targetId.toString();
    if (r.targetType === "user") {
      return {
        ...r,
        contentPreview: null,
        contentRemoved: false,
        linkable: true,
        linkTo: `/profile/${targetIdStr}`,
      };
    }

    let previewSource;
    if (r.targetType === "post") {
      const post = postById.get(targetIdStr);
      previewSource = {
        doc: post,
        missingLabel: "[post no longer exists]",
      };
    } else if (r.targetType === "comment") {
      const comment = commentById.get(targetIdStr);
      previewSource = {
        doc: comment,
        missingLabel: "[comment no longer exists]",
      };
    } else {
      const message = messageById.get(targetIdStr);
      previewSource = {
        doc: message,
        missingLabel: "[message no longer exists]",
      };
    }

    const { doc, missingLabel } = previewSource;
    // Media-only messages have no text to preview — label them by kind
    // instead of showing an empty string.
    const textPreview =
      doc && doc.text && doc.text.trim()
        ? doc.text
        : doc
          ? "[media message]"
          : missingLabel;

    return {
      ...r,
      contentPreview: textPreview,
      contentRemoved: Boolean(doc?.removedAt),
    };
  });

  return { reports: enriched, total, page, totalPages: Math.ceil(total / limit) };
};

export const resolveReport = async ({
  reportId,
  moderatorId,
  status,
  note,
  removeContent = false,
}) => {
  if (!["actioned", "dismissed"].includes(status)) {
    throw httpError(400, "status must be 'actioned' or 'dismissed'");
  }
  // Takedown is an "actioned"-only concept — dismissing a report must
  // never hide content, even if a client sends both fields together.
  if (removeContent && status !== "actioned") {
    throw httpError(400, "removeContent is only allowed when status is 'actioned'.");
  }

  // Load before resolving: the takedown needs targetType/targetId off the
  // report, and performing removal BEFORE the resolve update keeps the
  // invariant that a report only becomes resolved after the action it
  // implies has actually succeeded — a failed removal leaves the report
  // open to retry rather than silently actioned-with-content-intact.
  const report = await Report.findOne({ _id: reportId, status: "open" });
  if (!report) {
    throw httpError(404, "Report not found or already resolved.");
  }

  if (removeContent && report.targetType !== "user") {
    await removeTargetContent(report, moderatorId, note);
  }

  const updated = await Report.findOneAndUpdate(
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

  if (!updated) {
    throw httpError(404, "Report not found or already resolved.");
  }

  return updated;
};

// Soft-takedown of a report's target — sets removedBy/removedAt/
// removalReason instead of hard-deleting, mirroring the User.deletedAt
// pattern. Every user-facing read filters on removedAt: null, so the
// item vanishes from feeds/profiles/comments/chat while the row (and
// its media) survives for potential reversal. Idempotent: the
// removedAt: null guard means re-running against an already-removed
// target matches nothing instead of restamping the audit fields.
const removeTargetContent = async (report, moderatorId, reason) => {
  const patch = {
    removedBy: moderatorId,
    removedAt: new Date(),
    removalReason: reason || "",
  };

  if (report.targetType === "post") {
    const removed = await Post.findOneAndUpdate(
      { _id: report.targetId, removedAt: null },
      { $set: patch },
      { new: true },
    );
    if (!removed) return; // already removed, or hard-deleted in the meantime

    // Same invalidation set as createPost/deletePost — bump the author's
    // feed version and drop their shared profile-pages cache. Hashtag
    // pages cache per-tag; only scan those keys when the post carried
    // hashtags at all.
    invalidateFeedCache(removed.user);
    invalidateCache(`profile-posts:${removed.user}:*`);
    if (removed.hashtags?.length) {
      invalidateCache("hashtag:*");
    }
    return;
  }

  if (report.targetType === "comment") {
    const removed = await Comment.findOneAndUpdate(
      { _id: report.targetId, removedAt: null },
      { $set: patch },
      { new: true },
    );
    if (!removed) return;
    // Same keys commentController invalidates when creating/deleting.
    invalidateCache(`comments:${removed.post}`);
    invalidateCache(`replies:${removed._id}`);
    return;
  }

  if (report.targetType === "message") {
    // Messages are never cached (threads read straight from Mongo), so
    // no invalidation is needed — the next getMessages simply excludes it.
    await Message.updateOne(
      { _id: report.targetId, removedAt: null },
      { $set: patch },
    );
  }
};

// On-demand full context for ONE report — backs the requireModerator
// GET /reports/:id/context endpoint. The queue stays light (text
// previews only); this assembles everything the in-queue preview modal
// needs to render the actual flagged item:
//   post    -> the populated post, the exact shape feed/profile pages map
//              into PostCard so the modal renders it identically to feed
//   comment -> the comment PLUS its parent post (comments are meaningless
//              standalone; the modal shows the flagged row under its post)
//   message -> the flagged message plus up to 2 neighbours either side of
//              the same conversation, so the moderator judges it in
//              context rather than as one decontextualized line. Raw
//              conversation contents are reachable ONLY through this
//              moderator-gated endpoint — no other route exposes them.
//   user    -> no extra fetch; the queue deep-links to the profile.
export const getReportContext = async (reportId) => {
  const report = await Report.findById(reportId)
    .populate("reporter", "name username profilePic")
    .populate("targetOwner", "name username profilePic")
    .lean();
  if (!report) {
    throw httpError(404, "Report not found.");
  }

  if (report.targetType === "post") {
    const post = await Post.findById(report.targetId)
      .populate("user", "name username profilePic")
      .lean();
    if (!post) {
      throw httpError(404, "The reported post no longer exists.");
    }
    return { report, post };
  }

  if (report.targetType === "comment") {
    const comment = await Comment.findById(report.targetId)
      .populate("user", "name username profilePic")
      .lean();
    if (!comment) {
      throw httpError(404, "The reported comment no longer exists.");
    }
    const post = await Post.findById(comment.post)
      .populate("user", "name username profilePic")
      .lean();
    if (!post) {
      throw httpError(404, "The parent post no longer exists.");
    }
    return { report, comment, post };
  }

  if (report.targetType === "message") {
    const CHAT_PARTICIPANTS = [
      { path: "sender", select: "_id name username profilePic" },
      { path: "receiver", select: "_id name username profilePic" },
    ];
    const message = await Message.findById(report.targetId)
      .populate(CHAT_PARTICIPANTS)
      .lean();
    if (!message) {
      throw httpError(404, "The reported message no longer exists.");
    }
    const [before, after] = await Promise.all([
      Message.find({
        conversationId: message.conversationId,
        createdAt: { $lt: message.createdAt },
      })
        .sort({ createdAt: -1 })
        .limit(2)
        .populate(CHAT_PARTICIPANTS)
        .lean(),
      Message.find({
        conversationId: message.conversationId,
        createdAt: { $gt: message.createdAt },
      })
        .sort({ createdAt: 1 })
        .limit(2)
        .populate(CHAT_PARTICIPANTS)
        .lean(),
    ]);
    // Chronological window with the flagged message in the middle.
    return {
      report,
      messages: [...before.reverse(), message, ...after],
      flaggedMessageId: message._id.toString(),
    };
  }

  // User reports carry their context via the populated targetOwner.
  return { report };
};
