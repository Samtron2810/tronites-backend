import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import User from "../models/User.js";

// Registration normally requires a Brevo OTP round-trip (see
// authController.js's sendOtp/verifyOtp) — out of scope for a fast
// in-process smoke suite, which would need to mock the Brevo client to
// even get through it. These smoke tests exercise the routes *after*
// signup (posts, follows, blocks, etc.), so they seed a fully-onboarded
// user directly via the model instead, and mint the same JWT
// generateToken() would issue.
let counter = 0;

export const createTestUser = async (overrides = {}) => {
  counter += 1;
  const password = overrides.password || "TestPassword123!";
  const passwordHash = await bcrypt.hash(password, 10);

  const user = await User.create({
    name: overrides.name || `Test User ${counter}`,
    username: overrides.username || `testuser${counter}`,
    email: overrides.email || `testuser${counter}@example.com`,
    password: passwordHash,
    ...overrides,
  });

  return { user, password };
};

// Returns a `Cookie` header value ready to pass to supertest's
// .set("Cookie", ...) — mirrors what generateToken() sets at login,
// without going through an actual HTTP login round-trip.
export const authCookieFor = (user) => {
  const token = jwt.sign({ userId: user._id.toString() }, process.env.JWT_SECRET, {
    expiresIn: "7d",
  });
  return `token=${token}`;
};

// csrfProtection (see middleware/csrfProtection.js) rejects any
// non-GET request without a matching Origin header — this is one of
// the app's default-allowed origins (see config/allowedOrigins.js),
// so tests attach it the same way a real browser request would.
export const TEST_ORIGIN = "http://localhost:5173";
