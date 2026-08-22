import mongoose from "mongoose";

// One document per active refresh token (i.e. per logged-in device).
// This is what makes logout, "log out other devices", and stolen-cookie
// revocation possible without waiting out a JWT's natural expiry — the
// access token stays short-lived (15m) and unrevocable-by-design, but
// every refresh has to check against a live Session doc here, so
// deleting the doc immediately kills that session's ability to mint new
// access tokens.
const sessionSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    // HMAC-SHA256 of the refresh token, never the token itself — same
    // reasoning as Otp.otpHash: a DB read alone can't produce a usable
    // credential.
    tokenHash: {
      type: String,
      required: true,
      unique: true,
    },

    // Rotation chain: each refresh replaces this doc's tokenHash with a
    // fresh one rather than creating a new doc, so a session's identity
    // (and its createdAt "logged in since") persists across refreshes.
    // If a refresh token is ever reused after rotation (tokenHash
    // already replaced), that's a strong reuse-detection signal — see
    // refreshSession() in utils/tokens.js.
    lastUsedAt: { type: Date, default: Date.now },

    // Surfaced on a future "Sessions" settings screen so a user can see
    // and individually revoke devices.
    userAgent: { type: String, default: "" },
    ip: { type: String, default: "" },

    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

// TTL index: expired sessions clean themselves up, same pattern as Otp.
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model("Session", sessionSchema);
