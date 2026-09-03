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

// Eligibility thresholds
const ACCOUNT_MIN_AGE_DAYS = 30;
const LAST_LOGIN_MAX_DAYS = 180; // 6 months

// ─── Single write path for User.verifications ─────────────────────────
// Both adminController's direct grant endpoint AND resolveVerificationRequest
// call this — exactly one place ever mutates the array.
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

// ─── Eligibility check ────────────────────────────────────────────────
// Returns { eligible: true } or throws a 403 with a specific reason.
// All guards in one DB hit so the applicant gets one clear rejection.
const checkEligibility = (user, type) => {
  // Guard 1 — account age
  const accountAgeDays =
    (Date.now() - new Date(user.createdAt).getTime()) / (1000 * 60 * 60 * 24);
  if (accountAgeDays < ACCOUNT_MIN_AGE_DAYS) {
    const daysLeft = Math.ceil(ACCOUNT_MIN_AGE_DAYS - accountAgeDays);
    throw httpError(
      403,
      `Your account must be at least ${ACCOUNT_MIN_AGE_DAYS} days old to apply. ${daysLeft} day${daysLeft === 1 ? "" : "s"} remaining.`,
    );
  }

  // Guard 2 — good standing
  if (user.banned) {
    throw httpError(403, "Banned accounts can't apply for verification.");
  }
  if (user.suspendedUntil && new Date(user.suspendedUntil) > new Date()) {
    throw httpError(403, "Suspended accounts can't apply for verification.");
  }
  if ((user.strikes || []).length >= 3) {
    throw httpError(
      403,
      "Accounts with 3 or more active strikes can't apply for verification.",
    );
  }

  // Guard 3 — must have a bio, profile photo, and username set
  if (!user.username) {
    throw httpError(403, "You must set a username before applying.");
  }
  if (!user.bio || user.bio.trim().length < 1) {
    throw httpError(403, "Add a bio to your profile before applying.");
  }
  if (!user.profilePic) {
    throw httpError(403, "Add a profile photo before applying.");
  }

  // Guard 4 — account must be public
  if (user.isPrivate) {
    throw httpError(
      403,
      "Your account must be public to apply for verification. Switch to a public account in Settings.",
    );
  }

  // Guard 5 — must have logged in within the last 6 months
  if (!user.lastLoginAt) {
    throw httpError(
      403,
      "No recent login on record. Log in and try again.",
    );
  }
  const daysSinceLogin =
    (Date.now() - new Date(user.lastLoginAt).getTime()) / (1000 * 60 * 60 * 24);
  if (daysSinceLogin > LAST_LOGIN_MAX_DAYS) {
    throw httpError(
      403,
      "Your account must have been active (logged in) within the last 6 months.",
    );
  }

  // Guard 6 — already holds this badge
  if ((user.verifications || []).some((v) => v.type === type)) {
    throw httpError(409, `You already hold the ${type} badge.`);
  }

  return { eligible: true };
};

// ─── Submit application ───────────────────────────────────────────────
export const submitVerificationRequest = async ({
  userId,
  type,
  entityName,
  legalName,
  dateOfBirth,
  country,
  statement,
  publicLinks,
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

  const user = await User.findById(userId).select(
    "verifications createdAt strikes banned suspendedUntil username bio profilePic isPrivate lastLoginAt",
  );
  if (!user) throw httpError(404, "User not found.");

  checkEligibility(user, type);

  // Normalise publicLinks — strip empty strings, cap at 3
  const links = (publicLinks || []).filter((l) => l && l.trim()).slice(0, 3);

  try {
    const request = await VerificationRequest.create({
      user: userId,
      type,
      entityName: entityName || "",
      legalName,
      dateOfBirth,
      country,
      statement,
      publicLinks: links,
    });
    return request;
  } catch (err) {
    if (err.code === 11000) {
      throw httpError(409, `You already have a pending ${type} request under review.`);
    }
    throw err;
  }
};

// ─── Applicant's own requests ─────────────────────────────────────────
export const listMyVerificationRequests = async (userId) => {
  return VerificationRequest.find({ user: userId })
    .sort({ createdAt: -1 })
    .lean();
};

// ─── Reviewer queue ───────────────────────────────────────────────────
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

// ─── Resolve (approve / deny) ─────────────────────────────────────────
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

// ─── Eligibility pre-check (frontend can call before showing the form) ─
export const checkVerificationEligibility = async ({ userId, type }) => {
  const user = await User.findById(userId).select(
    "verifications createdAt strikes banned suspendedUntil username bio profilePic isPrivate lastLoginAt",
  );
  if (!user) throw httpError(404, "User not found.");

  checkEligibility(user, type);
  return { eligible: true };
};
