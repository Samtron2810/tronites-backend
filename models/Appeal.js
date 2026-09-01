import mongoose from "mongoose";

// APPEAL (3.1) — recourse for a suspended/banned user. A restriction is
// enforced everywhere (authMiddleware, loginUser, refreshAccessToken) so a
// restricted account can't reach any cookie-gated route to plead its case
// — submission is therefore credential-based (email+password), the same
// proof-of-ownership loginUser already accepts from a restricted account
// before rejecting it. See appealService.submitAppeal.
//
// One open appeal per user at a time (partial unique index below) — filing
// a second doesn't queue-jump, it just clutters the queue with duplicates
// of the same plea. A user may file again only after the first is decided.
const appealSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    // Snapshot of the restriction being appealed, taken at submission
    // time — so the queue and the eventual decision stay meaningful even
    // if a moderator lifts/changes the restriction out from under the
    // appeal (e.g. via the bulk endpoint) while it's still open.
    restrictionType: {
      type: String,
      enum: ["suspension", "ban"],
      required: true,
    },
    restrictionReason: {
      type: String,
      default: "",
      trim: true,
      maxlength: 500,
    },
    suspendedUntil: {
      type: Date,
      default: null,
    },

    // The user's own statement — why they think the restriction should
    // be lifted. Required; this is the entire content of the appeal.
    statement: {
      type: String,
      required: true,
      trim: true,
      minlength: 10,
      maxlength: 1000,
    },

    status: {
      type: String,
      enum: ["open", "granted", "denied"],
      default: "open",
    },

    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    reviewedAt: {
      type: Date,
      default: null,
    },
    // Moderator-facing decision note — mirrors Report.resolutionNote.
    decisionNote: {
      type: String,
      default: "",
      trim: true,
      maxlength: 500,
    },
  },
  { timestamps: true },
);

// Moderation queue lists open appeals oldest-first (same "don't let
// anything sit ignored" convention as Report).
appealSchema.index({ status: 1, createdAt: 1 });
// Enforces "one open appeal per user" without blocking a fresh appeal
// after the prior one was decided — partial index only counts open rows.
appealSchema.index(
  { user: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: "open" } },
);

const Appeal = mongoose.model("Appeal", appealSchema);

export default Appeal;
