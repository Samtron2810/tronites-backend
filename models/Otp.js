import mongoose from "mongoose";

const otpSchema = new mongoose.Schema(
  {
    // The public handle clients use for resend/verify — never the email
    // itself, so a challenge can't be probed or resumed just by knowing
    // (or guessing) someone's address.
    challengeId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },

    // Normalized so "User@Example.com" and "user@example.com" are always
    // treated as the same address — matches the same lowercase+trim
    // treatment on User.email.
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      index: true,
    },

    // HMAC-SHA256 of the code (see utils/otp.js), never the code itself
    // — a database read (backup, leaked snapshot, curious query) can't
    // recover a usable OTP from this field.
    otpHash: { type: String, required: true },

    payload: { type: mongoose.Schema.Types.Mixed },
    expiresAt: { type: Date, required: true },

    // Per-challenge verify attempt count — see MAX_VERIFY_ATTEMPTS in
    // services/otpService.js.
    attempts: { type: Number, default: 0 },

    // Set exactly once, atomically, on successful verification — see
    // verifyChallenge()'s conditional update. Its presence is what makes
    // "consume this code" a one-time operation instead of a re-usable one.
    usedAt: { type: Date, default: null },

    // Send-rate bookkeeping, shared by both the initial send and every
    // resend of the same challenge — see checkAndBumpSendRate() in
    // services/otpService.js for the cooldown + daily-cap logic that
    // reads these.
    lastSentAt: { type: Date, default: Date.now },
    sendCount: { type: Number, default: 1 },
    sendWindowStart: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

// TTL index: documents expire at `expiresAt`
otpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model("Otp", otpSchema);
