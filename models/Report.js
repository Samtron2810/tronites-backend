import mongoose from "mongoose";

// A single flag against a user-generated object or account. Kept as one
// polymorphic collection (rather than ReportedPost/ReportedComment/...)
// so a moderation queue can list everything in one query sorted by
// createdAt, instead of merging four collections client-side.
const reportSchema = new mongoose.Schema(
  {
    reporter: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
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
// reporting idempotent (see reportService).
reportSchema.index({ reporter: 1, targetType: 1, targetId: 1 }, { unique: true });
// "how many/which reports exist against this owner" — surfaces repeat
// offenders to a moderator without a full collection scan.
reportSchema.index({ targetOwner: 1, createdAt: -1 });

const Report = mongoose.model("Report", reportSchema);

export default Report;
