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
//
// Concurrency: `email` now carries a unique index (see models/Otp.js).
// Two parallel first-time requests for the same address can both read
// `existing === null` and both attempt the upsert — that's the race the
// old non-unique index allowed to silently create two challenges. With
// the unique index, exactly one of those two upserts wins; the loser
// gets a duplicate-key error instead of a second row. We catch that one
// error code and retry the whole read-rate-write cycle once, which on
// retry sees the winner's document and proceeds as a normal "replace
// the existing challenge" flow. A second collision in that retry window
// is astronomically unlikely (would need two more requests to land in
// the same few-millisecond gap) and is allowed to surface as a 500
// rather than retrying indefinitely.
const startChallengeOnce = async ({ email, payload, subject }) => {
  const existing = await Otp.findOne({ email });
  const rate = checkAndBumpSendRate(existing);

  const otp = generateOtp();
  const challengeId = generateChallengeId();
  const now = new Date();

  try {
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
  } catch (err) {
    if (err.code === 11000) {
      const raceErr = new Error("RACE_RETRY");
      raceErr.isRaceRetry = true;
      throw raceErr;
    }
    throw err;
  }

  await deliver(email, subject, otp);

  return { challengeId, email };
};

export const startChallenge = async ({ email, payload, subject }) => {
  try {
    return await startChallengeOnce({ email, payload, subject });
  } catch (err) {
    if (err.isRaceRetry) {
      return await startChallengeOnce({ email, payload, subject });
    }
    throw err;
  }
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
  // Reserve the attempt slot atomically FIRST — the filter's own
  // `attempts: { $lt: MAX_VERIFY_ATTEMPTS }` and the `$inc` happen as one
  // atomic document operation. Under the old code, N parallel requests
  // could each independently read `attempts: 4`, all pass the `< 5`
  // check, and all get to guess — the whole point of a 5-try cap. Here,
  // if five requests race, MongoDB serializes the five `$inc`s: whichever
  // ones observe attempts already at 5 get `reserved === null` and are
  // rejected before ever touching `otp`, regardless of arrival order.
  const reserved = await Otp.findOneAndUpdate(
    {
      challengeId,
      usedAt: null,
      attempts: { $lt: MAX_VERIFY_ATTEMPTS },
      expiresAt: { $gt: new Date() },
    },
    { $inc: { attempts: 1 } },
    { new: true },
  );

  if (!reserved) {
    // Distinguish "doesn't exist at all" from "exists but is out of
    // tries/expired/used" only enough to give an accurate message —
    // re-read is fine here since it's just for message selection, not
    // a security-relevant decision.
    const doc = await Otp.findOne({ challengeId });
    if (!doc) {
      throw httpError(400, "Code not found, already used, or expired.");
    }
    if (doc.usedAt) {
      throw httpError(400, "Code already used.");
    }
    if (doc.expiresAt < new Date()) {
      throw httpError(400, "Code expired. Please request a new one.");
    }
    throw httpError(400, "Too many incorrect attempts. Please request a new code.");
  }

  if (!verifyOtpHash(otp, reserved.otpHash)) {
    throw httpError(400, "Invalid code.");
  }

  const consumed = await Otp.findOneAndUpdate(
    { _id: reserved._id, usedAt: null },
    { $set: { usedAt: new Date() } },
    { new: true },
  );

  if (!consumed) {
    throw httpError(400, "Code already used.");
  }

  return { email: consumed.email, payload: consumed.payload, _id: consumed._id.toString() };
};

// Recovery path for the gap between "challenge verified" and "account
// actually created". verifyChallenge() must consume the challenge
// (clear-once semantics) before we know whether User.create() will
// succeed — otherwise two concurrent verify calls for the same code
// could both pass the check and both try to create the account. But
// that means a transient failure creating the User (duplicate email
// racing in from elsewhere, a validation error, a dropped DB
// connection) would otherwise strand the user with a "used" challenge
// and no account — no way to retry without starting over and waiting
// for a new email.
//
// This puts the challenge back to unused IF AND ONLY IF it's still the
// same document, still marked used, and still within its original
// expiry — so a legitimate retry (re-submit the same OTP) can succeed,
// but this can't resurrect a challenge that's expired or been
// reused/replaced by a newer send in the meantime.
export const unconsumeChallenge = async (challengeDocId) => {
  await Otp.updateOne(
    { _id: challengeDocId, usedAt: { $ne: null }, expiresAt: { $gt: new Date() } },
    { $set: { usedAt: null } },
  );
};
