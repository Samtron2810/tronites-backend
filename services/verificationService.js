import crypto from "crypto";
import User, { VERIFICATION_TYPES } from "../models/User.js";
import VerificationRequest from "../models/VerificationRequest.js";
import VerificationPayment from "../models/VerificationPayment.js";
import Notification from "../models/Notification.js";
import { initializeTransaction, verifyTransaction } from "./paystackService.js";
import { emitToUser } from "../socket/socket.js";

const httpError = (statusCode, message) => {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
};

const ADMIN_TARGET_SELECT =
  "_id name username email profilePic role verifications isVerified createdAt banned suspendedUntil restrictionReason strikes permissions";

const GRANTABLE_TYPES = ["individual", "business", "government", "creator"];

// Business and creator badges expire annually; individual and government
// are perpetual — identity established once.
const EXPIRING_TYPES = new Set(["business", "creator"]);
const EXPIRY_YEARS = 1;

const PAID_TYPES = ["business"];
const getBusinessFeeKobo = () => {
  const ngn = parseInt(process.env.BUSINESS_BADGE_PRICE_NGN || "5000", 10);
  return ngn * 100;
};

const ACCOUNT_MIN_AGE_DAYS = 30;
const LAST_LOGIN_MAX_DAYS = 180;

const BADGE_LABELS = {
  individual: "Individual",
  business: "Business",
  government: "Government",
  creator: "Creator",
};

// ─── Notification helper ──────────────────────────────────────────────
const fireVerificationNotification = async ({ recipientId, type, message }) => {
  try {
    const notif = await Notification.create({
      recipient: recipientId,
      sender: null, // system-generated
      type,
      message: message || "",
    });
    emitToUser(recipientId, "newNotification", notif);
  } catch (e) {
    console.error(`[verificationNotification] ${type} failed:`, e.message);
  }
};

// ─── Grant ────────────────────────────────────────────────────────────
export const grantVerificationToUser = async ({
  userId, type, entityName, expiresAt, reviewedBy,
}) => {
  if (type === "staff") {
    throw httpError(400, "Staff badges derive from role and can't be granted directly.");
  }
  if (!GRANTABLE_TYPES.includes(type)) {
    throw httpError(400, "Invalid verification type.");
  }
  if (["business", "government"].includes(type) && !entityName) {
    throw httpError(400, `entityName is required for a ${type} badge.`);
  }
  if (expiresAt && new Date(expiresAt) <= new Date()) {
    throw httpError(400, "expiresAt must be in the future.");
  }

  const target = await User.findById(userId).select(ADMIN_TARGET_SELECT);
  if (!target) throw httpError(404, "User not found.");

  // Auto-set expiry for annually-renewing types unless admin overrides.
  let resolvedExpiry = expiresAt || null;
  if (!expiresAt && EXPIRING_TYPES.has(type)) {
    const d = new Date();
    d.setFullYear(d.getFullYear() + EXPIRY_YEARS);
    resolvedExpiry = d;
  }

  const existingIndex = (target.verifications || []).findIndex((v) => v.type === type);
  const entry = {
    type,
    verifiedAt: new Date(),
    expiresAt: resolvedExpiry,
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

// ─── Revoke ───────────────────────────────────────────────────────────
export const revokeVerificationFromUser = async ({ userId, type }) => {
  if (!VERIFICATION_TYPES.includes(type)) {
    throw httpError(400, "Invalid verification type.");
  }
  const target = await User.findById(userId).select(ADMIN_TARGET_SELECT);
  if (!target) throw httpError(404, "User not found.");

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
const checkEligibility = (user, type) => {
  const accountAgeDays =
    (Date.now() - new Date(user.createdAt).getTime()) / (1000 * 60 * 60 * 24);
  if (accountAgeDays < ACCOUNT_MIN_AGE_DAYS) {
    const daysLeft = Math.ceil(ACCOUNT_MIN_AGE_DAYS - accountAgeDays);
    throw httpError(
      403,
      `Your account must be at least ${ACCOUNT_MIN_AGE_DAYS} days old to apply. ${daysLeft} day${daysLeft === 1 ? "" : "s"} remaining.`,
    );
  }
  if (user.banned) throw httpError(403, "Banned accounts can't apply for verification.");
  if (user.suspendedUntil && new Date(user.suspendedUntil) > new Date()) {
    throw httpError(403, "Suspended accounts can't apply for verification.");
  }
  if ((user.strikes || []).length >= 3) {
    throw httpError(403, "Accounts with 3 or more active strikes can't apply.");
  }
  if (!user.username) throw httpError(403, "You must set a username before applying.");
  if (!user.bio || user.bio.trim().length < 1) {
    throw httpError(403, "Add a bio to your profile before applying.");
  }
  if (!user.profilePic) throw httpError(403, "Add a profile photo before applying.");
  if (user.isPrivate) {
    throw httpError(403, "Your account must be public to apply for verification.");
  }
  if (!user.lastLoginAt) {
    throw httpError(403, "No recent login on record. Log in and try again.");
  }
  const daysSinceLogin =
    (Date.now() - new Date(user.lastLoginAt).getTime()) / (1000 * 60 * 60 * 24);
  if (daysSinceLogin > LAST_LOGIN_MAX_DAYS) {
    throw httpError(403, "Your account must have been active within the last 6 months.");
  }
  if ((user.verifications || []).some((v) => v.type === type)) {
    throw httpError(409, `You already hold the ${type} badge.`);
  }

  // Creator badge requires an active Individual badge first.
  if (type === "creator") {
    const hasActiveIndividual = (user.verifications || []).some(
      (v) =>
        v.type === "individual" &&
        (!v.expiresAt || new Date(v.expiresAt) > new Date()),
    );
    if (!hasActiveIndividual) {
      throw httpError(
        403,
        "The Creator badge requires an active Individual verification badge. Apply for Individual first.",
      );
    }
  }

  return { eligible: true };
};

// ─── Payment: initiate ────────────────────────────────────────────────
export const initiateVerificationPayment = async ({ userId, type }) => {
  if (!PAID_TYPES.includes(type)) {
    throw httpError(400, `${type} badge does not require payment.`);
  }

  const user = await User.findById(userId).select(
    "email verifications createdAt strikes banned suspendedUntil username bio profilePic isPrivate lastLoginAt",
  );
  if (!user) throw httpError(404, "User not found.");

  checkEligibility(user, type);

  const existing = await VerificationPayment.findOne({
    user: userId,
    status: "verified",
    consumedAt: null,
  });
  if (existing) {
    return { alreadyPaid: true, paymentId: existing._id, amountKobo: existing.amountKobo };
  }

  const amountKobo = getBusinessFeeKobo();
  const reference = `tronites_vbiz_${crypto.randomBytes(12).toString("hex")}`;

  const callbackBase = process.env.PAYSTACK_CALLBACK_URL;
  const callbackUrl = callbackBase
    ? `${callbackBase.replace(/\/$/, "")}?paystack_ref=${reference}`
    : undefined;

  const paystackData = await initializeTransaction({
    email: user.email,
    amountKobo,
    reference,
    metadata: { userId: userId.toString(), badgeType: type, platform: "tronites" },
    callbackUrl,
  });

  const payment = await VerificationPayment.create({
    user: userId,
    reference,
    amountKobo,
    status: "initiated",
  });

  return {
    alreadyPaid: false,
    paymentId: payment._id,
    reference,
    authorizationUrl: paystackData.authorization_url,
    amountKobo,
    amountNgn: amountKobo / 100,
  };
};

// ─── Payment: verify ──────────────────────────────────────────────────
export const verifyVerificationPayment = async ({ userId, reference }) => {
  const payment = await VerificationPayment.findOne({ reference, user: userId });
  if (!payment) throw httpError(404, "Payment record not found.");

  if (payment.status === "verified" && !payment.consumedAt) {
    return { verified: true, paymentId: payment._id };
  }
  if (payment.consumedAt) {
    throw httpError(409, "This payment has already been used to submit an application.");
  }
  if (payment.status === "failed") {
    throw httpError(402, "This payment failed. Please initiate a new payment.");
  }

  const data = await verifyTransaction(reference);
  const succeeded = data.status === "success";

  await VerificationPayment.findByIdAndUpdate(payment._id, {
    $set: { status: succeeded ? "verified" : "failed", paystackStatus: data.status || "unknown" },
  });

  if (!succeeded) {
    throw httpError(402, `Payment not successful (status: ${data.status}). Please try again.`);
  }
  return { verified: true, paymentId: payment._id };
};

// ─── Submit application ───────────────────────────────────────────────
export const submitVerificationRequest = async ({
  userId, type, entityName, legalName, dateOfBirth,
  country, statement, publicLinks, paymentId,
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

  let paymentDoc = null;
  if (PAID_TYPES.includes(type)) {
    if (!paymentId) {
      throw httpError(402, "A verified payment is required to submit a business badge application.");
    }
    paymentDoc = await VerificationPayment.findOne({
      _id: paymentId, user: userId, status: "verified", consumedAt: null,
    });
    if (!paymentDoc) {
      throw httpError(402, "No valid verified payment found. Please complete payment before submitting.");
    }
  }

  const links = (publicLinks || []).filter((l) => l && l.trim()).slice(0, 3);

  let request;
  try {
    request = await VerificationRequest.create({
      user: userId,
      type,
      entityName: entityName || "",
      legalName,
      dateOfBirth,
      country,
      statement,
      publicLinks: links,
      paymentRef: paymentDoc?._id || null,
    });
  } catch (err) {
    if (err.code === 11000) {
      throw httpError(409, `You already have a pending ${type} request under review.`);
    }
    throw err;
  }

  if (paymentDoc) {
    await VerificationPayment.findByIdAndUpdate(paymentDoc._id, {
      $set: { consumedAt: new Date() },
    });
  }

  return request;
};

// ─── Applicant's own requests ─────────────────────────────────────────
export const listMyVerificationRequests = async (userId) => {
  return VerificationRequest.find({ user: userId }).sort({ createdAt: -1 }).lean();
};

// ─── Reviewer queue ───────────────────────────────────────────────────
export const listVerificationRequests = async ({ status = "pending", page = 1, limit = 25 } = {}) => {
  const skip = (page - 1) * limit;
  const filter = status === "all" ? {} : { status };

  const [requests, total] = await Promise.all([
    VerificationRequest.find(filter)
      .sort({ status: 1, createdAt: 1 })
      .skip(skip)
      .limit(limit)
      .populate("user", "name username profilePic verifications isVerified createdAt")
      .populate("paymentRef", "amountKobo paystackStatus createdAt")
      .lean(),
    VerificationRequest.countDocuments(filter),
  ]);

  return { requests, total, page, totalPages: Math.ceil(total / limit) };
};

// ─── Resolve ──────────────────────────────────────────────────────────
export const resolveVerificationRequest = async ({ requestId, reviewerId, decision, note }) => {
  if (!["approved", "denied"].includes(decision)) {
    throw httpError(400, "decision must be 'approved' or 'denied'.");
  }

  const request = await VerificationRequest.findOne({ _id: requestId, status: "pending" });
  if (!request) throw httpError(404, "Request not found or already resolved.");

  let updatedUser = null;
  if (decision === "approved") {
    updatedUser = await grantVerificationToUser({
      userId: request.user,
      type: request.type,
      entityName: request.entityName,
      expiresAt: null, // auto-computed inside grant for expiring types
      reviewedBy: reviewerId,
    });
  }

  const updatedRequest = await VerificationRequest.findOneAndUpdate(
    { _id: requestId, status: "pending" },
    { $set: { status: decision, reviewedBy: reviewerId, reviewedAt: new Date(), decisionNote: note || "" } },
    { returnDocument: "after" },
  );
  if (!updatedRequest) throw httpError(404, "Request not found or already resolved.");

  // Notify applicant — best effort, never blocks the response.
  const label = BADGE_LABELS[request.type] || request.type;
  if (decision === "approved") {
    const expiryNote = EXPIRING_TYPES.has(request.type)
      ? ` It is valid for ${EXPIRY_YEARS} year and will need renewal.`
      : "";
    await fireVerificationNotification({
      recipientId: request.user,
      type: "verification_approved",
      message: `Your ${label} verification badge has been approved.${expiryNote}`,
    });
  } else {
    const reason = note
      ? ` Reason: ${note}`
      : " You may reapply after addressing the feedback.";
    await fireVerificationNotification({
      recipientId: request.user,
      type: "verification_denied",
      message: `Your ${label} verification application was not approved.${reason}`,
    });
  }

  return { request: updatedRequest, user: updatedUser };
};

// ─── Eligibility pre-check ────────────────────────────────────────────
export const checkVerificationEligibility = async ({ userId, type }) => {
  const user = await User.findById(userId).select(
    "verifications createdAt strikes banned suspendedUntil username bio profilePic isPrivate lastLoginAt",
  );
  if (!user) throw httpError(404, "User not found.");
  checkEligibility(user, type);
  return {
    eligible: true,
    requiresPayment: PAID_TYPES.includes(type),
    feeNgn: PAID_TYPES.includes(type) ? getBusinessFeeKobo() / 100 : 0,
  };
};

export const getVerificationFeeInfo = () => ({
  business:   { requiresPayment: true,  feeNgn: getBusinessFeeKobo() / 100 },
  individual: { requiresPayment: false, feeNgn: 0 },
  government: { requiresPayment: false, feeNgn: 0 },
  creator:    { requiresPayment: false, feeNgn: 0 },
});
