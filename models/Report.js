import mongoose from "mongoose";

// A single flag against a user-generated object or account. Kept as one
// polymorphic collection (rather than ReportedPost/ReportedComment/...)
// so a moderation queue can list everything in one query sorted by
// createdAt, instead of merging four collections client-side.
const reportSchema = new mongoose.Schema(
  {
    // Null for system-generated reports (Phase 7 pre-moderation — see
    // services/preModerationService.js). Every human-submitted report
    // still requires a reporter; only the automated heuristics path is
    // allowed to omit one, so `required` can't just be dropped — it's
    // enforced conditionally below instead.
    reporter: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      required: function () {
        return !this.system;
      },
    },

    // Phase 7 — true when this row was raised by automated pre-moderation
    // heuristics (utils/moderationHeuristics.js) rather than a human
    // report. Lets the queue/UI badge it distinctly ("Flagged by system")
    // and lets resolveReport's audit trail distinguish false-positive
    // tuning from real user complaints.
    system: {
      type: Boolean,
      default: false,
    },

    // Which heuristic(s) fired, e.g. ["slur_list", "link_spam"]. Empty
    // for human reports. Kept as free-form strings (not an enum) so new
    // heuristics don't require a schema migration.
    signals: {
      type: [String],
      default: [],
    },

    // What kind of thing is being reported. "user" covers profile-level
    // reports (harassment pattern, impersonation, spam account) that
    // aren't about one specific post/comment/message.
    targetType: {
      type: String,
      enum: ["user", "post", "comment", "message"],
      required: true,
    },

    // Polymorphic reference — points into User/Post/Comment/Message
    // depending on targetType. Not a `ref` on the field itself since the
    // ref model varies; consumers dereference manually using targetType.
    targetId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },

    // Who owns/authored the reported object — denormalized at report
    // time so the moderation queue and any future "reports against this
    // user" lookups don't need a join back through Post/Comment/Message
    // just to find out who's being reported.
    targetOwner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    reason: {
      type: String,
      enum: [
        "spam",
        "harassment",
        "hate_speech",
        "violence",
        "nudity_sexual_content",
        "self_harm",
        "impersonation",
        "misinformation",
        "other",
      ],
      required: true,
    },

    // Free-text detail, optional, capped short — this is context for a
    // moderator, not a place for a full essay.
    details: {
      type: String,
      trim: true,
      maxlength: 500,
      default: "",
    },

    // Phase 6 — queue urgency. Raised automatically by the hourly
    // flagRepeatOffenders job when an owner crosses the repeat-offender
    // threshold, so a pile-up surfaces at the top of the queue instead of
    // waiting for someone to notice the pile-up itself.
    priority: {
      type: String,
      enum: ["normal", "high"],
      default: "normal",
    },

    status: {
      type: String,
      enum: ["open", "actioned", "dismissed"],
      default: "open",
    },

    // Set when a moderator resolves the report (either actioned or
    // dismissed) — null while still open.
    resolvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    resolvedAt: {
      type: Date,
      default: null,
    },
    resolutionNote: {
      type: String,
      trim: true,
      maxlength: 500,
      default: "",
    },
  },
  { timestamps: true },
);

// Moderation queue lists open reports newest-first.
reportSchema.index({ status: 1, createdAt: -1 });
// "has this reporter already flagged this exact object" — used to make
// reporting idempotent (see reportService). Partial filter excludes
// system reports (reporter: null) so multiple automated flags against
// different targets never collide on the unique index.
reportSchema.index(
  { reporter: 1, targetType: 1, targetId: 1 },
  { unique: true, partialFilterExpression: { reporter: { $type: "objectId" } } },
);
// System reports are deduped per-target instead (see
// preModerationService.flagContent) — one open system report per object.
reportSchema.index(
  { system: 1, targetType: 1, targetId: 1 },
  { unique: true, partialFilterExpression: { system: true } },
);
// "how many/which reports exist against this owner" — surfaces repeat
// offenders to a moderator without a full collection scan.
reportSchema.index({ targetOwner: 1, createdAt: -1 });

const Report = mongoose.model("Report", reportSchema);

export default Report;
