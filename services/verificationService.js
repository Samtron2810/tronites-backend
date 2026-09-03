import User, { VERIFICATION_TYPES } from "../models/User.js";
import VerificationRequest from "../models/VerificationRequest.js";

const httpError = (statusCode, message) => {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
};

const ADMIN_TARGET_SELECT =
  "_id name username email profilePic role verifications isVerified createdAt banned suspendedUntil restrictionReason strikes permissions";

const GRANTABLE_TYPES = ["individual", "business", "government", "creator"];

// Phase 3 constants
const ACCOUNT_MIN_AGE_DAYS = 30;
const KYC_ATTEMPT_CAP = 3;
const KYC_ATTEMPT_WINDOW_DAYS = 90;
const KYC_AUTO_APPROVE_CONFIDENCE = 80; // Dojah NIN face-match threshold

// Single write path for User.verifications — both adminController's
// direct grant endpoint AND resolveVerificationRequest (below) call this,
// so there is exactly one place that ever mutates the array. Mirrors the
// same "one code path" discipline as reactionService for the Reaction
// model.
export const grantVerificationToUser = async ({
  userId,
  type,
  entityName,
  expiresAt,
  reviewedBy,
}) => {
  if (type === "staff") {
    throw httpError(
      400,
      "Staff badges derive from role and can't be granted directly — promote to moderator/admin instead.",
    );
  }
  if (!GRANTABLE_TYPES.includes(type)) {
    throw httpError(400, "Invalid verification type.");
  }
  if (["business", "government"].includes(type) && !entityName) {
    throw httpError(
      400,
      `entityName is required for a ${type} badge — that's the whole point of the claim.`,
    );
  }
  if (expiresAt && new Date(expiresAt) <= new Date()) {
    throw httpError(400, "expiresAt must be in the future.");
  }

  const target = await User.findById(userId).select(ADMIN_TARGET_SELECT);
  if (!target) {
    throw httpError(404, "User not found.");
  }

  const existingIndex = (target.verifications || []).findIndex(
    (v) => v.type === type,
  );
  const entry = {
    type,
    verifiedAt: new Date(),
    expiresAt: expiresAt || null,
    method: "manual",
    providerRef: "",
    entityName: entityName || "",
    reviewedBy,
  };

  if (existingIndex >= 0) {
    target.verifications[existingIndex] = entry;
  } else {
    target.verifications.push(entry);
  }
  target.isVerified = true;

  await target.save();
  return target;
};

export const revokeVerificationFromUser = async ({ userId, type }) => {
  if (!VERIFICATION_TYPES.includes(type)) {
    throw httpError(400, "Invalid verification type.");
  }

  const target = await User.findById(userId).select(ADMIN_TARGET_SELECT);
  if (!target) {
    throw httpError(404, "User not found.");
  }

  const before = target.verifications.length;
  target.verifications = target.verifications.filter((v) => v.type !== type);
  if (target.verifications.length === before) {
    throw httpError(400, `User doesn't hold a ${type} badge.`);
  }
  target.isVerified = target.verifications.length > 0;

  await target.save();
  return target;
};

// ─── Phase 2 — self-service application queue ──────────────────────────

// Submit a badge application. One pending request per (user, type) —
// enforced by the model's partial unique index; the try/catch here turns
// the resulting E11000 into the same friendly 409 pattern
// appealService.submitAppeal uses for its own one-open-appeal rule.
export const submitVerificationRequest = async ({
  userId,
  type,
  entityName,
  statement,
}) => {
  if (type === "staff") {
    throw httpError(400, "Staff badges can't be requested — they derive from role.");
  }
  if (!GRANTABLE_TYPES.includes(type)) {
    throw httpError(400, "Invalid verification type.");
  }
  if (["business", "government"].includes(type) && !entityName) {
    throw httpError(400, `entityName is required for a ${type} badge.`);
  }

  // Pull the full user doc once so we can run all guards in one DB hit.
  const user = await User.findById(userId).select(
    "verifications createdAt strikes banned suspendedUntil kycLockedUntil kycAttempts kycLastAttemptAt",
  );
  if (!user) throw httpError(404, "User not found.");

  // Guard 1 — account must be ≥ 30 days old. Prevents badge-farming on
  // freshly created throwaway accounts. Same timestamp-comparison pattern
  // as usernameChangedAt cooldown in userController.
  const accountAgeDays =
    (Date.now() - new Date(user.createdAt).getTime()) / (1000 * 60 * 60 * 24);
  if (accountAgeDays < ACCOUNT_MIN_AGE_DAYS) {
    const daysLeft = Math.ceil(ACCOUNT_MIN_AGE_DAYS - accountAgeDays);
    throw httpError(
      403,
      `Your account must be at least ${ACCOUNT_MIN_AGE_DAYS} days old to apply for verification. ${daysLeft} day${daysLeft === 1 ? "" : "s"} remaining.`,
    );
  }

  // Guard 2 — account must be in good standing.
  if (user.banned) {
    throw httpError(403, "Banned accounts can't apply for verification.");
  }
  if (user.suspendedUntil && new Date(user.suspendedUntil) > new Date()) {
    throw httpError(403, "Suspended accounts can't apply for verification.");
  }
  if ((user.strikes || 0) >= 3) {
    throw httpError(
      403,
      "Accounts with 3 or more active strikes can't apply for verification.",
    );
  }

  // Guard 3 — KYC lock (Individual only). A user is locked if they've
  // burned their KYC attempt budget in the rolling window.
  if (type === "individual" && user.kycLockedUntil && new Date(user.kycLockedUntil) > new Date()) {
    const until = new Date(user.kycLockedUntil).toLocaleDateString();
    throw httpError(
      429,
      `You've used all ${KYC_ATTEMPT_CAP} KYC attempts for this period. You can try again after ${until}.`,
    );
  }

  // Guard 4 — already holds this badge.
  if (user.verifications?.some((v) => v.type === type)) {
    throw httpError(409, `You already hold the ${type} badge.`);
  }

  try {
    const request = await VerificationRequest.create({
      user: userId,
      type,
      entityName: entityName || "",
      statement,
    });
    return request;
  } catch (err) {
    if (err.code === 11000) {
      throw httpError(409, `You already have a pending ${type} request under review.`);
    }
    throw err;
  }
};

// Called when the user ticks consent and the frontend is about to launch
// the Dojah widget. Records consent, increments the KYC attempt counter,
// and returns the request so the frontend has a fresh reference_id to
// pass to the widget. Only valid for Individual requests — other types
// don't use the KYC widget.
export const initiateKyc = async ({ requestId, userId }) => {
  const [request, user] = await Promise.all([
    VerificationRequest.findOne({ _id: requestId, user: userId, status: "pending" }),
    User.findById(userId).select("kycAttempts kycLastAttemptAt kycLockedUntil"),
  ]);

  if (!request) throw httpError(404, "Verification request not found.");
  if (request.type !== "individual") {
    throw httpError(400, "KYC initiation is only for Individual badge requests.");
  }
  if (request.consentGiven) {
    // Idempotent — consent already recorded, just return the request so
    // the widget can be re-launched if the user closed it prematurely.
    return request;
  }

  // Check KYC lock again at initiation time (belt-and-suspenders; the
  // submit guard already checked, but time may have passed).
  if (user.kycLockedUntil && new Date(user.kycLockedUntil) > new Date()) {
    throw httpError(429, "KYC attempts exhausted for this period.");
  }

  // Reset attempt counter if the window has expired.
  const windowMs = KYC_ATTEMPT_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const windowExpired =
    !user.kycLastAttemptAt ||
    Date.now() - new Date(user.kycLastAttemptAt).getTime() > windowMs;
  const newAttempts = windowExpired ? 1 : (user.kycAttempts || 0) + 1;
  const locked = newAttempts >= KYC_ATTEMPT_CAP;

  await User.findByIdAndUpdate(userId, {
    $set: {
      kycAttempts: newAttempts,
      kycLastAttemptAt: new Date(),
      kycLockedUntil: locked
        ? new Date(Date.now() + windowMs)
        : null,
    },
  });

  // Stamp consent + set kycStatus to "pending" (widget launched).
  request.consentGiven = true;
  request.consentAt = new Date();
  request.kycStatus = "pending";
  await request.save();

  return request;
};

// The requesting user's own queue — every request they've filed,
// newest first, so Settings can show live status without a moderator
// round trip.
export const listMyVerificationRequests = async (userId) => {
  return VerificationRequest.find({ user: userId })
    .sort({ createdAt: -1 })
    .lean();
};

// Reviewer queue — pending requests oldest-first, same convention as
// reportService.listReports / appealService.listAppeals.
export const listVerificationRequests = async ({
  status = "pending",
  page = 1,
  limit = 25,
} = {}) => {
  const skip = (page - 1) * limit;
  const filter = status === "all" ? {} : { status };

  const [requests, total] = await Promise.all([
    VerificationRequest.find(filter)
      .sort({ status: 1, createdAt: 1 })
      .skip(skip)
      .limit(limit)
      .populate("user", "name username profilePic verifications isVerified createdAt")
      .lean(),
    VerificationRequest.countDocuments(filter),
  ]);

  return { requests, total, page, totalPages: Math.ceil(total / limit) };
};

// Called by the Dojah webhook handler (webhookController.js). Finds the
// VerificationRequest by Dojah's reference_id, then either auto-approves
// (confidence ≥ threshold, NIN verified) or flags for manual review.
// NEVER stores NIN number, BVN, selfie URL, or any raw identity data —
// only the opaque Dojah reference ID. See PrivacyPolicy KYC section.
export const processKycWebhook = async ({
  referenceId,
  dojahStatus,
  confidence,
  kycProviderRef,
}) => {
  const request = await VerificationRequest.findOne({
    _id: referenceId,
    status: "pending",
    type: "individual",
    kycStatus: "pending",
  });
  if (!request) {
    // Already resolved or not found — webhook may be a duplicate/replay.
    return { skipped: true };
  }

  const autoApprove = dojahStatus === true && confidence >= KYC_AUTO_APPROVE_CONFIDENCE;

  request.kycConfidence = confidence ?? null;
  request.kycProviderRef = kycProviderRef || "";
  request.kycStatus = autoApprove ? "auto_approved" : confidence > 0 ? "manual_review" : "failed";

  if (autoApprove) {
    // Single write path — same function the admin grant endpoint calls.
    await grantVerificationToUser({
      userId: request.user,
      type: "individual",
      entityName: "",
      expiresAt: null,
      reviewedBy: null, // system-granted, no human reviewer
    });

    request.status = "approved";
    request.reviewedAt = new Date();
    request.decisionNote = `Auto-approved via KYC (confidence: ${confidence}).`;
  }
  // If not auto-approved, leave status "pending" — drops into the
  // reviewer's "manual_review" queue in ModerationQueue → Verification tab.

  await request.save();
  return { autoApproved: autoApprove, request };
};

// Approve = grant the badge via the single write path above AND resolve
// the request. Deny = resolve only, nothing granted. Both require the
// request to still be pending — same findOneAndUpdate-with-status-guard
// pattern as resolveAppeal, so resolving twice is rejected rather than
// silently double-processed.
export const resolveVerificationRequest = async ({
  requestId,
  reviewerId,
  decision,
  note,
}) => {
  if (!["approved", "denied"].includes(decision)) {
    throw httpError(400, "decision must be 'approved' or 'denied'.");
  }

  const request = await VerificationRequest.findOne({
    _id: requestId,
    status: "pending",
  });
  if (!request) {
    throw httpError(404, "Request not found or already resolved.");
  }

  let updatedUser = null;
  if (decision === "approved") {
    updatedUser = await grantVerificationToUser({
      userId: request.user,
      type: request.type,
      entityName: request.entityName,
      expiresAt: null,
      reviewedBy: reviewerId,
    });
  }

  const updatedRequest = await VerificationRequest.findOneAndUpdate(
    { _id: requestId, status: "pending" },
    {
      $set: {
        status: decision,
        reviewedBy: reviewerId,
        reviewedAt: new Date(),
        decisionNote: note || "",
      },
    },
    { returnDocument: "after" },
  );

  if (!updatedRequest) {
    throw httpError(404, "Request not found or already resolved.");
  }

  return { request: updatedRequest, user: updatedUser };
};
