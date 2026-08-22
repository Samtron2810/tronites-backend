import express from "express";
import {
  sendOtp,
  verifyOtp,
  resendOtp,
  forgotPassword,
  resetPassword,
  loginUser,
  logoutUser,
  refreshAccessToken,
  getMe,
} from "../controllers/authController.js";

import protect from "../middleware/authMiddleware.js";
import { validate } from "../utils/validators.js";
import {
  registerSchema,
  loginSchema,
  validateOtpSchema,
  resendOtpSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
} from "../utils/validators.js";
import { authLimiter } from "../middleware/rateLimiter.js";

const router = express.Router();

// Keep legacy /register to maintain backward compatibility — it now sends OTP
router.post("/register", authLimiter, validate(registerSchema), sendOtp);
router.post("/send-otp", authLimiter, validate(registerSchema), sendOtp);
router.post("/verify-otp", authLimiter, validate(validateOtpSchema), verifyOtp);
router.post("/resend-otp", authLimiter, validate(resendOtpSchema), resendOtp);

// Forgot/reset password — both share the authLimiter (10/15min per IP) so
// a single client can't spam reset emails or brute-force reset codes.
router.post(
  "/forgot-password",
  authLimiter,
  validate(forgotPasswordSchema),
  forgotPassword,
);
router.post(
  "/reset-password",
  authLimiter,
  validate(resetPasswordSchema),
  resetPassword,
);

router.post("/login", authLimiter, validate(loginSchema), loginUser);
router.post("/logout", logoutUser);
// No auth middleware here by design — the whole point of /refresh is to
// mint a new access token when the old one has already expired, so it
// only checks the refresh token cookie, not `protect`'s access-token
// check. authLimiter still applies to bound brute-force attempts against
// the refresh cookie itself.
router.post("/refresh", authLimiter, refreshAccessToken);
router.get("/me", protect, getMe);

export default router;
