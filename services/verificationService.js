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

  const user = await User.findById(userId).select("verifications");
  if (user?.verifications?.some((v) => v.type === type)) {
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
