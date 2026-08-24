import mongoose from "mongoose";

// AUDIT LOG (Phase 3) — append-only record of moderation state-changes:
// restrictions and their reversal, role changes, and report resolutions.
//
// Design rules:
//   • Write-only from the app's perspective — no API creates or edits
//     entries; only listAuditLogs (requireAdmin) reads them.
//   • Self-contained rows: actor and target are denormalized snapshots
//     taken at write time, so entries stay meaningful even if the user
//     later renames, is hard-deleted, or loses their role. Nothing is
//     ever .populate()d — a log must not break because a referenced doc
//     died.
//   • No TTL / auto-purge: moderation history is kept forever by intent.

// Kept beside the schema so the enum and any filtering UI share one
// source of truth (adminController imports this list for its $in filter).
export const AUDIT_ACTIONS = [
  "user_suspended",
  "user_banned",
  "user_unrestricted",
  "user_role_changed",
  "report_resolved",
];

const AUDIT_TARGET_TYPES = ["user", "post", "comment", "message", "report"];

const auditLogSchema = new mongoose.Schema(
  {
    // Who performed the action (snapshot from req.user at write time).
    actor: {
      _id: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true,
      },
      name: { type: String, default: "" },
      username: { type: String, default: null },
      role: { type: String, default: "" },
    },

    // What happened.
    action: {
      type: String,
      required: true,
      enum: AUDIT_ACTIONS,
      index: true,
    },

    // What it happened to.
    target: {
      type: { type: String, enum: AUDIT_TARGET_TYPES, required: true },
      ref: { type: mongoose.Schema.Types.ObjectId, required: true },
      // Free-form summary (name/username/role for users; targetType for
      // reports) — Mixed so each action stores what's relevant without
      // schema churn across phases.
      snapshot: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    },

    // Action-specific payload: reason, suspendedUntil, toRole,
    // resolution status/note…
    detail: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },

    ip: { type: String, default: "" },
    userAgent: { type: String, default: "" },
  },
  // createdAt is the query axis; updatedAt would be dead weight on an
  // immutable collection.
  { timestamps: { createdAt: true, updatedAt: false } },
);

auditLogSchema.index({ createdAt: -1 });
auditLogSchema.index({ "actor._id": 1, createdAt: -1 });
auditLogSchema.index({ "target.type": 1, "target.ref": 1 });

const AuditLog = mongoose.model("AuditLog", auditLogSchema);

export default AuditLog;
