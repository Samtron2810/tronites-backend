import bcrypt from "bcryptjs";
import User from "../models/User.js";
import {
  issueSession,
  refreshSession,
  revokeSession,
  revokeAllSessions,
  clearAuthCookies,
  REFRESH_COOKIE_NAME,
} from "../utils/tokens.js";
import { toPrivateSelfDTO } from "../dtos/userDTO.js";
import {
  startChallenge,
  resendChallenge,
  verifyChallenge,
  unconsumeChallenge,
} from "../services/otpService.js";
import { generateChallengeId } from "../utils/otp.js";
import { passwordResetEmailTemplate } from "../utils/emailTemplate.js";

// REGISTER
// SEND OTP (used for registration)
//
// Response is intentionally identical whether or not the email is
// already registered — see the neutral message below. Login enumeration
// was closed with a generic error + constant-time comparison (see
// loginUser below); registration used to still leak account existence
// via a distinct "already used" message, letting anyone probe arbitrary
// addresses. A real account owner gets the *actual* OTP email either
// way; an attacker probing addresses gets nothing to distinguish
// "sent" from "already registered" from the API response alone.
export const sendOtp = async (req, res) => {
  try {
    const { firstName, lastName, email, password } = req.body; // already trimmed+validated by registerSchema

    const userExists = await User.findOne({ email }).select("_id");

    if (userExists) {
      // Do NOT reveal existence. Do NOT start/send a real challenge for
      // an address that's already an account — that would email an
      // existing user an unsolicited registration code.
      //
      // Still return a well-formed challengeId matching the exact shape
      // startChallenge() would (see utils/otp.js) — the frontend always
      // expects one to navigate to /verify-otp. Because no Otp document
      // exists with this id, any code submitted against it fails
      // verifyChallenge()'s existence check with the same generic
      // "Code not found, already used, or expired" message a truly
      // wrong/expired code produces. Nothing in the response, or in
      // what happens next, differs from the real-send path.
      return res.status(200).json({
        message: "If this address can be registered, we've sent a code.",
        challengeId: generateChallengeId(),
        email,
      });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const { challengeId } = await startChallenge({
      email,
      payload: { firstName, lastName, passwordHash },
      subject: "Your Tronites OTP",
    });

    return res.status(200).json({
      message: "If this address can be registered, we've sent a code.",
      challengeId,
      email,
    });
  } catch (error) {
    // Rate-limit (429) errors are intentionally still surfaced as-is —
    // they're about request volume from whoever is calling the API, not
    // about whether a specific email exists, so they don't reintroduce
    // enumeration.
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

// VERIFY OTP and create user
export const verifyOtp = async (req, res) => {
  let verified = null;
  try {
    const { challengeId, otp } = req.body;

    verified = await verifyChallenge({ challengeId, otp });
    const { email, payload, _id: otpDocId } = verified;

    // Create user from payload
    const { firstName, lastName, passwordHash } = payload || {};

    if (!firstName || !lastName || !passwordHash) {
      return res.status(400).json({ message: "Invalid OTP payload" });
    }

    let user;
    try {
      user = await User.create({ firstName, lastName, email, password: passwordHash });
    } catch (createErr) {
      // The challenge is already marked used (verifyChallenge's job is
      // to guarantee a code can't be consumed twice). If account
      // creation itself then fails — duplicate email racing in via a
      // different path, a transient Mongo error, a validation edge
      // case — the correct code is gone and the user has no way to
      // retry without waiting for a brand-new email. Put the challenge
      // back to "unused" so a client retry with the same OTP can
      // succeed once the transient condition clears.
      await unconsumeChallenge(otpDocId);

      if (createErr.code === 11000) {
        return res.status(409).json({
          message: "That email was just registered. Please log in instead.",
        });
      }
      throw createErr;
    }

    // Generate session (access + refresh token cookies)
    await issueSession(res, user._id, {
      userAgent: req.headers["user-agent"] || "",
      ip: req.ip || "",
    });

    res.status(201).json(toPrivateSelfDTO(user));
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

// RESEND OTP
export const resendOtp = async (req, res) => {
  try {
    const { challengeId } = req.body;

    await resendChallenge({
      challengeId,
      subject: "Your Tronites OTP (Resend)",
    });

    res.status(200).json({ message: "OTP resent" });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

// FORGOT PASSWORD
//
// Response is intentionally identical whether or not the email is
// registered — the same anti-enumeration pattern as sendOtp above. A real
// account owner gets the actual OTP email; an attacker probing addresses
// gets no signal. Unlike sendOtp, a "fake challenge" for an unknown
// address carries NO payload, so even if an attacker happened to obtain a
// challengeId from a non-existent account (e.g. via a captured response),
// resetPassword's payload.type check would reject it.
export const forgotPassword = async (req, res) => {
  try {
    const { email } = req.body; // already trimmed+lowercased by forgotPasswordSchema

    const user = await User.findOne({ email }).select("_id");

    if (!user) {
      // Do NOT reveal existence. Do NOT start/send a real challenge for
      // an address with no account — that would only waste rate-limit
      // budget and email. Return a well-formed but non-existent
      // challengeId so the response shape is identical to the success
      // path; any OTP submitted against it fails verifyChallenge()'s
      // existence check with the generic error.
      return res.status(200).json({
        message: "If this address is registered, we've sent a code.",
        challengeId: generateChallengeId(),
        email,
      });
    }

    const { challengeId } = await startChallenge({
      email,
      // Distinguishes this from a registration challenge. resetPassword
      // refuses any challenge whose payload isn't exactly this — so a
      // registration OTP (payload { name, passwordHash }) can never be
      // redirected to reset a password.
      payload: { type: "passwordReset" },
      subject: "Reset your Tronites password",
      emailTemplate: passwordResetEmailTemplate,
    });

    return res.status(200).json({
      message: "If this address is registered, we've sent a code.",
      challengeId,
      email,
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

// RESET PASSWORD (verify OTP + set new password)
//
// The verification itself is handled entirely by verifyChallenge() in
// otpService.js — atomic single-use consumption, 5-attempt cap, 5-minute
// expiry, timing-safe HMAC comparison. This controller's only extra job
// is confirming the challenge was created for a password reset (payload
// type check) and then updating the user's password + passwordChangedAt
// so every previously-issued JWT becomes invalid (see authMiddleware).
export const resetPassword = async (req, res) => {
  try {
    const { challengeId, otp, newPassword } = req.body;

    const verified = await verifyChallenge({ challengeId, otp });
    const { email, payload } = verified;

    // Registration challenges carry payload { name, passwordHash }; fake
    // challenges (unknown email in forgotPassword) carry no payload at
    // all. Only challenges explicitly created for a reset are accepted
    // here — the optional chaining means a missing payload fails the
    // check and is rejected instead of crashing.
    if (payload?.type !== "passwordReset") {
      return res.status(400).json({ message: "Invalid OTP payload" });
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);

    // passwordChangedAt drives the session-invalidation check in
    // authMiddleware for any access token still valid from before this
    // reset. That covers the 15-minute access-token window; the refresh
    // tokens covering the following 30 days are killed outright here so
    // a stolen refresh token from before the reset can't mint further
    // access tokens either.
    await User.updateOne(
      { email },
      {
        $set: {
          password: passwordHash,
          passwordChangedAt: new Date(),
        },
      },
    );

    const resetUser = await User.findOne({ email }).select("_id");
    if (resetUser) await revokeAllSessions(resetUser._id);

    res
      .status(200)
      .json({ message: "Password reset successful. Please sign in." });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

// Precomputed once at startup, reused for every login attempt against an
// unknown account. Keeps "no such user" and "wrong password" taking
// about the same time — a generic error message alone doesn't stop
// enumeration if one path is consistently faster than the other, since
// bcrypt.compare's cost is what dominates response time here.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync(
  "dummy-password-for-timing-safety",
  10,
);

// LOGIN
export const loginUser = async (req, res) => {
  try {
    const { identifier, password } = req.body;

    // Accept either an email or a username in the same field — a plain
    // "@" check is enough since usernames are restricted to
    // lowercase/digits/underscore and can never contain one.
    const query = identifier.includes("@")
      ? { email: identifier.trim().toLowerCase() }
      : { username: identifier.toLowerCase() };

    const user = await User.findOne(query);

    const isMatch = await bcrypt.compare(
      password,
      user ? user.password : DUMMY_PASSWORD_HASH,
    );

    if (!user || !isMatch) {
      return res
        .status(400)
        .json({ message: "Invalid email/username or password" });
    }

    // A soft-deleted account can't log back in during its grace window
    // through the normal flow — this intentionally isn't the "reactivate
    // my account" path (there isn't one yet), just a clear rejection
    // instead of a confusing immediate 401 on the very next request via
    // authMiddleware's own deletedAt check.
    if (user.deletedAt) {
      return res.status(403).json({
        message: "This account has been deleted.",
        code: "ACCOUNT_DELETED",
      });
    }

    // Phase 2 restrictions — same codes authMiddleware uses mid-session,
    // so a suspended/banned user gets the same specific screen whether
    // they were blocked at login or on their next API call.
    if (user.banned) {
      return res.status(403).json({
        message: "Your account has been banned.",
        code: "ACCOUNT_BANNED",
      });
    }
    if (
      user.suspendedUntil &&
      new Date(user.suspendedUntil) > new Date()
    ) {
      return res.status(403).json({
        message: `Your account is suspended until ${new Date(
          user.suspendedUntil,
        ).toLocaleString()}.`,
        code: "ACCOUNT_SUSPENDED",
        suspendedUntil: user.suspendedUntil,
      });
    }
    // An expired suspension doesn't block login (mirrors authMiddleware).

    await issueSession(res, user._id, {
      userAgent: req.headers["user-agent"] || "",
      ip: req.ip || "",
    });

    res.status(200).json(toPrivateSelfDTO(user));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// REFRESH — exchanges a valid refresh token for a new access token (and
// rotates the refresh token itself). Called by the frontend axios
// interceptor when a request comes back 401 due to access-token expiry,
// so a 15-minute access token doesn't force a re-login every 15 minutes.
export const refreshAccessToken = async (req, res) => {
  try {
    const presented = req.cookies[REFRESH_COOKIE_NAME];
    const result = await refreshSession(res, presented);

    if (!result) {
      clearAuthCookies(res);
      return res.status(401).json({ message: "Session expired, please log in again" });
    }

    // A banned or actively-suspended account must not keep minting access
    // tokens from a live refresh cookie — protect() would reject every
    // request anyway, but letting rotation continue would leave pointless
    // Session rows and fresh cookies on a dead account. Kill all sessions
    // (the presented one was ALREADY rotated inside refreshSession, so
    // revoking everything is the only way to also kill that fresh row)
    // and clear both cookies.
    const refreshedUser = await User.findById(result.userId).select(
      "banned suspendedUntil deletedAt",
    );
    if (
      refreshedUser &&
      (refreshedUser.deletedAt ||
        refreshedUser.banned ||
        (refreshedUser.suspendedUntil &&
          new Date(refreshedUser.suspendedUntil) > new Date()))
    ) {
      const code = refreshedUser.deletedAt
        ? "ACCOUNT_DELETED"
        : refreshedUser.banned
          ? "ACCOUNT_BANNED"
          : "ACCOUNT_SUSPENDED";
      await revokeAllSessions(result.userId);
      clearAuthCookies(res);
      return res.status(403).json({
        message:
          code === "ACCOUNT_BANNED"
            ? "Your account has been banned."
            : code === "ACCOUNT_SUSPENDED"
              ? `Your account is suspended until ${new Date(
                  refreshedUser.suspendedUntil,
                ).toLocaleString()}.`
              : "This account has been deleted.",
        code,
      });
    }

    res.status(200).json({ message: "Refreshed" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

//logout controller
export const logoutUser = async (req, res) => {
  await revokeSession(req.cookies[REFRESH_COOKIE_NAME]);
  clearAuthCookies(res);

  res.status(200).json({ message: "Logged out" });
};

//get current user
export const getMe = async (req, res) => {
  res.status(200).json(toPrivateSelfDTO(req.user));
};
