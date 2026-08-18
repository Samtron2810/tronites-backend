import User from "../models/User.js";
import Post from "../models/Post.js";
import Comment from "../models/Comment.js";
import Message from "../models/Message.js";
import { createReport, listReports, resolveReport } from "../services/reportService.js";

// Maps a report's targetType to the model that owns the object and the
// field on it that identifies its author — needed to resolve
// `targetOwner` server-side rather than trusting whatever the client
// sends (a client claiming someone else "owns" content it doesn't own
// would let a report misattribute blame to an innocent account).
const TARGET_LOOKUP = {
  user: { Model: User, ownerField: null }, // reporting a user IS reporting its owner
  post: { Model: Post, ownerField: "user" },
  comment: { Model: Comment, ownerField: "user" },
  message: { Model: Message, ownerField: "sender" },
};

// CREATE REPORT — flags a user, post, comment, or message.
export const createReportHandler = async (req, res) => {
  try {
    const { targetType, targetId, reason, details } = req.body;

    const lookup = TARGET_LOOKUP[targetType];
    if (!lookup) {
      return res.status(400).json({ message: "Invalid target type." });
    }

    const target = await lookup.Model.findById(targetId).select(
      lookup.ownerField || "_id",
    );
    if (!target) {
      return res.status(404).json({ message: "Reported content not found." });
    }

    const targetOwner = lookup.ownerField ? target[lookup.ownerField] : target._id;

    const report = await createReport({
      reporterId: req.user._id,
      targetType,
      targetId,
      targetOwner,
      reason,
      details,
    });

    res.status(201).json({
      message: "Report submitted. Thanks for helping keep Tronites safe.",
      reportId: report._id,
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

// MODERATION QUEUE — list reports (moderator/admin only, see routes).
export const listReportsHandler = async (req, res) => {
  try {
    const status = req.query.status || "open";
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 100);

    const result = await listReports({ status, page, limit });
    res.status(200).json(result);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

// RESOLVE REPORT — mark actioned or dismissed (moderator/admin only).
export const resolveReportHandler = async (req, res) => {
  try {
    const { status, note } = req.body;
    const report = await resolveReport({
      reportId: req.params.id,
      moderatorId: req.user._id,
      status,
      note,
    });
    res.status(200).json({ report });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};
