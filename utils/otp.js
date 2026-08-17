import crypto from "crypto";

// Dedicated secret for HMAC-hashing OTPs, distinct from JWT_SECRET so
// leaking one doesn't compromise the other. Falls back to JWT_SECRET
// (already required at startup — see config/loadEnv.js) so this doesn't
// force a new mandatory env var on top of everything else, but a
// dedicated secret is recommended.
const OTP_HASH_SECRET = process.env.OTP_HASH_SECRET || process.env.JWT_SECRET;

if (!process.env.OTP_HASH_SECRET) {
  console.warn(
    "OTP_HASH_SECRET is not set — falling back to JWT_SECRET for OTP hashing. Recommended: set a dedicated OTP_HASH_SECRET.",
  );
}

// crypto.randomInt is a CSPRNG — Math.random() is not, and its output is
// predictable enough (given a handful of samples) to make brute-forcing
// or guessing OTP sequences meaningfully easier.
export const generateOtp = () => crypto.randomInt(100000, 1000000).toString();

// The public handle a client uses to resend/verify — never the email
// itself, so a challenge can't be probed, resumed, or enumerated just by
// knowing (or guessing) someone's address. base64url keeps it URL/JSON
// safe with no padding characters to escape.
export const generateChallengeId = () =>
  crypto.randomBytes(24).toString("base64url");

export const hashOtp = (otp) =>
  crypto.createHmac("sha256", OTP_HASH_SECRET).update(otp).digest("hex");

// Timing-safe comparison — a plain `===` on hashes leaks how many
// leading bytes matched via response timing, which (with enough
// requests) can help an attacker recover the hash byte by byte.
export const verifyOtpHash = (otp, hash) => {
  const candidate = Buffer.from(hashOtp(otp), "hex");
  const expected = Buffer.from(hash, "hex");
  if (candidate.length !== expected.length) return false;
  return crypto.timingSafeEqual(candidate, expected);
};
