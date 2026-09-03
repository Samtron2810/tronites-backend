import mongoose from "mongoose";
import User from "../models/User.js";
import ModeratorNote from "../models/ModeratorNote.js";
import AuditLog from "../models/AuditLog.js";
import Report from "../models/Report.js";

// Phase 7 (roadmap 3.6) — moderator notes + one-screen case history.
// AuditLog is already indexed on {"target.type":1,"target.ref":1} (see
// models/AuditLog.js), so pulling "every past action against this
// account" is a single indexed query — this just assembles that
// alongside notes/strikes/report count so the admin panel has one call
// to make per profile instead of four.

const httpError = (statusCode, message) => {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
};

export const addModeratorNote = async ({ userId, authorId, body }) => {
  const target = await User.findById(userId).select("_id");
  if (!target) throw httpError(404, "User not found.");

  const note = await ModeratorNote.create({
    user: userId,
    author: authorId,
    body,
  });
  return note.populate("author", "name username profilePic verifications isVerified");
};

export const listModeratorNotes = async (userId) => {
  return ModeratorNote.find({ user: userId })
    .sort({ createdAt: -1 })
    .populate("author", "name username profilePic verifications isVerified")
    .lean();
};

export const deleteModeratorNote = async ({ noteId, requesterId, requesterRole }) => {
  const note = await ModeratorNote.findById(noteId);
  if (!note) throw httpError(404, "Note not found.");

  // Same "own work only unless admin" pattern used elsewhere for
  // moderator-authored content — prevents one moderator silently erasing
  // another's documented reasoning.
  if (requesterRole !== "admin" && note.author.toString() !== requesterId.toString()) {
    throw httpError(403, "You can only delete your own notes.");
  }

  await note.deleteOne();
};

// GET /admin/users/:id/case-history — everything a moderator needs to
// judge "what's this account's track record" on one screen:
//   - profile + current restriction state
//   - strikes (full detail — this endpoint IS the moderator-only view
//     toAdminUserDTO deliberately withholds strike reasons from)
//   - free-text moderator notes
//   - report count (open/total) filed against this account
//   - full AuditLog trail where this user is the target
export const getUserCaseHistory = async (userId) => {
  if (!mongoose.isValidObjectId(userId)) {
    throw httpError(400, "Invalid user id.");
  }

  const user = await User.findById(userId).select(
    "name username email profilePic role createdAt banned suspendedUntil restrictionReason strikes",
  );
  if (!user) throw httpError(404, "User not found.");

  const [notes, auditEntries, openReports, totalReports] = await Promise.all([
    ModeratorNote.find({ user: userId })
      .sort({ createdAt: -1 })
      .populate("author", "name username profilePic verifications isVerified")
      .lean(),
    AuditLog.find({ "target.type": "user", "target.ref": userId })
      .sort({ createdAt: -1 })
      .limit(100)
      .lean(),
    Report.countDocuments({ targetOwner: userId, status: "open" }),
    Report.countDocuments({ targetOwner: userId }),
  ]);

  return {
    user: {
      _id: user._id,
      name: user.name,
      username: user.username,
      email: user.email,
      profilePic: user.profilePic,
      role: user.role,
      createdAt: user.createdAt,
      banned: user.banned,
      suspendedUntil: user.suspendedUntil,
      restrictionReason: user.restrictionReason,
      strikes: user.strikes || [],
    },
    notes,
    auditLog: auditEntries,
    reportCounts: { open: openReports, total: totalReports },
  };
};
