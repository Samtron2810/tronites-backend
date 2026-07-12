import express from "express";
import {
  sendOtp,
  verifyOtp,
  resendOtp,
  loginUser,
  logoutUser,
  getMe,
} from "../controllers/authController.js";

import protect from "../middleware/authMiddleware.js";
import { validate } from "../utils/validators.js";
import {
  registerSchema,
  loginSchema,
  validateOtpSchema,
} from "../utils/validators.js";
import { authLimiter } from "../middleware/rateLimiter.js";

const router = express.Router();

// Keep legacy /register to maintain backward compatibility — it now sends OTP
router.post("/register", authLimiter, validate(registerSchema), sendOtp);
router.post("/send-otp", authLimiter, validate(registerSchema), sendOtp);
router.post("/verify-otp", authLimiter, validate(validateOtpSchema), verifyOtp);
router.post("/resend-otp", authLimiter, resendOtp);

router.post("/login", authLimiter, validate(loginSchema), loginUser);
router.post("/logout", logoutUser);
router.get("/me", protect, getMe);

export default router;
