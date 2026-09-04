import mongoose from "mongoose";
import { VERIFICATION_TYPES } from "./User.js";

// VERIFICATION REQUEST (Phase 2) — self-service application queue.
// Deliberately simple: no file uploads, no KYC provider, no consent
// flows. A reviewer reads the submitted info, checks public sources, and
// decides. This is the TikTok-style "fill a form, wait for review" model.
//
// "staff" excluded from applicable types — staff badge derives from role
// automatically and can never be independently applied for.
const APPLICABLE_TYPES = VERIFICATION_TYPES.filter((t) => t !== "staff");

const verificationRequestSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    type: {
      type: String,
      enum: APPLICABLE_TYPES,
      required: true,
    },

    // For business/government badge requests: the legal entity being
    // attested to — same requirement as the grant endpoint.
    entityName: {
      type: String,
      default: "",
      trim: true,
      maxlength: 120,
    },

    // ── Identity & account details (always required) ──────────────────
    // Legal name — may differ from display name. Not stored as a live
    // identity link; purely for reviewer context.
    legalName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },

    // Date of birth — age confirmation only. Reviewer checks "is this
    // person plausibly old enough to run this account / business".
    // Stored as a plain string (YYYY-MM-DD from the date input) — we
    // never compute from it server-side, just display to reviewer.
    dateOfBirth: {
      type: String,
      required: true,
      trim: true,
      maxlength: 10, // YYYY-MM-DD
    },

    // Country of residence / nationality.
    country: {
      type: String,
      required: true,
      trim: true,
      maxlength: 80,
    },

    // ── Why this account qualifies ────────────────────────────────────
    // Free-text case. Required; reviewer reads this alongside the
    // account's public profile to make the call.
    statement: {
      type: String,
      required: true,
      trim: true,
      minlength: 20,
      maxlength: 1000,
    },

    // Optional: public profile links (website, LinkedIn, official page)
    // that help a reviewer verify the claim without requiring doc uploads.
    // Up to 3 URLs, stored as a plain string array.
    publicLinks: {
      type: [String],
      default: [],
      validate: {
        validator: (arr) => arr.length <= 3,
        message: "Maximum 3 public links allowed.",
      },
    },

    // ── Payment (business badge only) ────────────────────────────────
    // Reference to the VerificationPayment that funded this submission.
    // Null for free-tier types (individual, government, creator).
    paymentRef: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "VerificationPayment",
      default: null,
    },

    // ── Review state ──────────────────────────────────────────────────
    status: {
      type: String,
      enum: ["pending", "approved", "denied"],
      default: "pending",
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
    // Shown back to the applicant so a denial is never a silent dead end.
    decisionNote: {
      type: String,
      default: "",
      trim: true,
      maxlength: 500,
    },
  },
  { timestamps: true },
);

// Review queue: pending first, oldest first — same "nothing sits ignored"
// convention as Report/Appeal.
verificationRequestSchema.index({ status: 1, createdAt: 1 });

// One open (pending) request PER TYPE per user — mirrors Appeal's
// one-open constraint, scoped per type so a user can simultaneously have
// a pending Individual and a pending Business request.
verificationRequestSchema.index(
  { user: 1, type: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: "pending" } },
);

const VerificationRequest = mongoose.model(
  "VerificationRequest",
  verificationRequestSchema,
);

export default VerificationRequest;
