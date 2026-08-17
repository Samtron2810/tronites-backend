import bcrypt from "bcryptjs";
import User from "../models/User.js";
import generateToken, { clearAuthCookie } from "../utils/generateToken.js";
import { toPrivateSelfDTO } from "../dtos/userDTO.js";
import { startChallenge, resendChallenge, verifyChallenge } from "../services/otpService.js";

// REGISTER
// SEND OTP (used for registration)
export const sendOtp = async (req, res) => {
  try {
    const { name, email, password } = req.body; // already trimmed+lowercased by registerSchema

    const userExists = await User.findOne({ email });

    if (userExists) {
      return res.status(400).json({ message: "Email is already been used" });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const { challengeId } = await startChallenge({
      email,
      payload: { name, passwordHash },
      subject: "Your Tronites OTP",
    });

    return res
      .status(200)
      .json({ message: "OTP sent to your email", challengeId, email });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

// VERIFY OTP and create user
export const verifyOtp = async (req, res) => {
  try {
    const { challengeId, otp } = req.body;

    const { email, payload } = await verifyChallenge({ challengeId, otp });

    // Create user from payload
    const { name, passwordHash } = payload || {};

    if (!name || !passwordHash) {
      return res.status(400).json({ message: "Invalid OTP payload" });
    }

    const user = await User.create({ name, email, password: passwordHash });

    // Generate token cookie
    generateToken(res, user._id);

    res.status(201).json({
      _id: user._id,
      name: user.name,
      email: user.email,
      username: user.username,
    });
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

    generateToken(res, user._id);

    res.status(200).json({
      _id: user._id,
      name: user.name,
      email: user.email,
      username: user.username,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

//logout controller
export const logoutUser = (req, res) => {
  clearAuthCookie(res);

  res.status(200).json({ message: "Logged out" });
};

//get current user
export const getMe = async (req, res) => {
  res.status(200).json(toPrivateSelfDTO(req.user));
};
