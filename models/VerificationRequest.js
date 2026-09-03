import mongoose from "mongoose";
import { VERIFICATION_TYPES } from "./User.js";

// VERIFICATION REQUEST (Phase 2) — self-service application queue that
// feeds the same manual-review grant/revoke path built in Phase 1
// (adminController.grantVerification). This model does NOT grant
// anything itself; approving a request just calls grantVerification
// under the hood so there is exactly one code path that ever writes to
// User.verifications — see verificationService.resolveVerificationRequest.
//
// "staff" is excluded from the applicable enum below for the same reason
// it's excluded from grantVerificationSchema: it derives from role, never
// from an application.
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

    // Required for business/government at submission time — same rule
    // enforced in grantVerificationSchema, duplicated here because a
    // request is filled out by the applicant before any admin sees it.
    entityName: {
      type: String,
      default: "",
      trim: true,
      maxlength: 120,
    },

    // The applicant's own case for the claim — why this account
    // qualifies. Required; short free text, not a document upload (no
    // file storage in Phase 2 — see rollout note below).
    statement: {
      type: String,
      required: true,
      trim: true,
      minlength: 10,
      maxlength: 1000,
    },

    // Phase 2 deliberately has NO document/ID upload field. Evidence
    // review is still 100% human: a reviewer reads the statement, checks
    // public sources (company registry, official domain, notability),
    // and decides. Wiring an actual KYC provider (ID capture, liveness
    // check, document storage with its own retention/encryption
    // requirements) is Phase 3's job, not bolted onto this queue model.
    status: {
      type: String,
      enum: ["pending", "approved", "denied"],
      default: "pending",
    },

    // KYC-specific fields — only populated for Individual badge requests
    // that go through the Dojah widget flow. Other badge types (business,
    // government, creator) go straight to the manual review queue with
    // these left at defaults.
    //
    // kycStatus tracks the webhook outcome independently of the overall
    // request status so the reviewer queue can distinguish "pending
    // manual review because KYC confidence was borderline" from "pending
    // because no KYC has been run yet."
    kycStatus: {
      type: String,
      enum: ["none", "pending", "auto_approved", "manual_review", "failed"],
      default: "none",
    },
    // Dojah's confidence score for the NIN face-match (0–100). Stored
    // so a reviewer can see exactly how borderline a manual_review case
    // is. Never exposed publicly — admin/reviewer only.
    kycConfidence: {
      type: Number,
      default: null,
    },
    // Opaque Dojah reference ID returned in the webhook. This is the
    // ONLY Dojah/identity data we store — never NIN number, BVN, selfie
    // URL, or document scan. See PrivacyPolicy KYC section.
    kycProviderRef: {
      type: String,
      default: "",
    },

    // NDPR / legal requirement: explicit consent must be recorded before
    // any identity data flows to Dojah. The KycConsentModal on the
    // frontend sets these; the backend verificationRoutes endpoint
    // rejects a KYC initiation request if consentGiven is not true.
    consentGiven: {
      type: Boolean,
      default: false,
    },
    consentAt: {
      type: Date,
      default: null,
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
    // Reviewer-facing decision note — mirrors Appeal.decisionNote /
    // Report.resolutionNote. Shown back to the applicant so a denial
    // isn't a silent dead end.
    decisionNote: {
      type: String,
      default: "",
      trim: true,
      maxlength: 500,
    },
  },
  { timestamps: true },
);

// Review queue lists pending requests oldest-first — same "nothing sits
// ignored" convention as Report/Appeal.
verificationRequestSchema.index({ status: 1, createdAt: 1 });

// One open (pending) request PER TYPE per user — a user can legitimately
// have a pending Individual request and a pending Business request at
// the same time (they're independent claims, see the claim-model doc),
// but filing a second Individual request while the first is still
// pending is a duplicate, not a new plea. Mirrors Appeal's one-open
// constraint, scoped per type instead of globally.
verificationRequestSchema.index(
  { user: 1, type: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: "pending" } },
);

const VerificationRequest = mongoose.model(
  "VerificationRequest",
  verificationRequestSchema,
);

export default VerificationRequest;
