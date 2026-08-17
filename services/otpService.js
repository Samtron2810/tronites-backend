import Otp from "../models/Otp.js";
import { generateOtp, generateChallengeId, hashOtp, verifyOtpHash } from "../utils/otp.js";
import { sendEmail } from "../utils/brevoEmail.js";
import { otpEmailTemplate } from "../utils/emailTemplate.js";

const OTP_TTL_MS = 5 * 60 * 1000; // 5 minutes
const RESEND_COOLDOWN_MS = 60 * 1000; // 60 seconds between any two sends
const MAX_SENDS_PER_DAY = 5;
const SEND_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_VERIFY_ATTEMPTS = 5;

const httpError = (statusCode, message) => {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
};

// Pure — no I/O — so it's testable without a database. Takes the
// existing doc (or null, for a brand-new challenge) and the current
// time, and returns the {sendCount, sendWindowStart} to persist, or
// throws a 429 if the caller should be blocked.
//
// Shared by both a fresh send and every resend of the same challenge,
// since the resource being protected — how many OTP emails land in one
// inbox — is the same either way; there's no reason a "new" send should
// bypass the cooldown a resend is subject to.
export const checkAndBumpSendRate = (existingDoc, now = Date.now()) => {
  if (!existingDoc) {
    return { sendCount: 1, sendWindowStart: new Date(now) };
  }

  const msSinceLastSend = now - existingDoc.lastSentAt.getTime();
  if (msSinceLastSend < RESEND_COOLDOWN_MS) {
    throw httpError(429, "Please wait before requesting another code.");
  }

  const windowExpired =
    now - existingDoc.sendWindowStart.getTime() > SEND_WINDOW_MS;
  if (windowExpired) {
    return { sendCount: 1, sendWindowStart: new Date(now) };
  }

  if (existingDoc.sendCount >= MAX_SENDS_PER_DAY) {
    throw httpError(
      429,
      "Too many codes requested for this email today. Please try again later.",
    );
  }

  return {
    sendCount: existingDoc.sendCount + 1,
    sendWindowStart: existingDoc.sendWindowStart,
  };
};

const deliver = async (email, subject, otp) => {
  try {
    await sendEmail({ to: email, subject, htmlContent: otpEmailTemplate(otp) });
  } catch (emailErr) {
    throw httpError(502, emailErr.message);
  }
};

// Starts a brand-new verification challenge for `email`, replacing any
// existing one for that address (one active challenge per email at a
// time — matches the previous upsert-by-email design). Returns the
// opaque challengeId the client uses for every subsequent resend/verify
// call; the email itself is never used as a lookup key again after this.
export const startChallenge = async ({ email, payload, subject }) => {
  const existing = await Otp.findOne({ email });
  const rate = checkAndBumpSendRate(existing);

  const otp = generateOtp();
  const challengeId = generateChallengeId();
  const now = new Date();

  await Otp.findOneAndUpdate(
    { email },
    {
      challengeId,
      otpHash: hashOtp(otp),
      payload,
      expiresAt: new Date(now.getTime() + OTP_TTL_MS),
      attempts: 0,
      usedAt: null,
      lastSentAt: now,
      sendCount: rate.sendCount,
      sendWindowStart: rate.sendWindowStart,
    },
    { upsert: true, setDefaultsOnInsert: true },
  );

  await deliver(email, subject, otp);

  return { challengeId, email };
};

// Resends a code for an existing challenge — same rate limits, same
// challengeId, fresh code and expiry, attempts reset (a new code
// deserves a fresh set of guesses rather than inheriting a count run up
// against the old one).
export const resendChallenge = async ({ challengeId, subject }) => {
  const existing = await Otp.findOne({ challengeId });
  if (!existing) {
    throw httpError(400, "This code has expired or doesn't exist. Please start again.");
  }

  const rate = checkAndBumpSendRate(existing);
  const otp = generateOtp();
  const now = new Date();

  existing.otpHash = hashOtp(otp);
  existing.expiresAt = new Date(now.getTime() + OTP_TTL_MS);
  existing.attempts = 0;
  existing.lastSentAt = now;
  existing.sendCount = rate.sendCount;
  existing.sendWindowStart = rate.sendWindowStart;
  await existing.save();

  await deliver(existing.email, subject, otp);

  return { email: existing.email };
};

// Atomically verifies and consumes a challenge. "Atomic" specifically
// means the usedAt flip is a single conditional update — {_id, usedAt:
// null} — rather than a separate check-then-write, so two concurrent
// verify calls for the same challenge (a double-submitted request, a
// retried network call) can only ever succeed once. The loser gets
// "already used" instead of both creating an account.
export const verifyChallenge = async ({ challengeId, otp }) => {
  const doc = await Otp.findOne({ challengeId, usedAt: null });

  if (!doc) {
    throw httpError(400, "Code not found, already used, or expired.");
  }

  if (doc.expiresAt < new Date()) {
    throw httpError(400, "Code expired. Please request a new one.");
  }

  if (doc.attempts >= MAX_VERIFY_ATTEMPTS) {
    throw httpError(400, "Too many incorrect attempts. Please request a new code.");
  }

  if (!verifyOtpHash(otp, doc.otpHash)) {
    await Otp.updateOne({ _id: doc._id }, { $inc: { attempts: 1 } });
    throw httpError(400, "Invalid code.");
  }

  const consumed = await Otp.findOneAndUpdate(
    { _id: doc._id, usedAt: null },
    { $set: { usedAt: new Date() } },
    { new: true },
  );

  if (!consumed) {
    throw httpError(400, "Code already used.");
  }

  return { email: consumed.email, payload: consumed.payload };
};
