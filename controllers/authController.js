import bcrypt from "bcryptjs";
import User from "../models/User.js";
import Otp from "../models/Otp.js";
import generateToken from "../utils/generateToken.js";
import { sendEmail } from "../utils/brevoEmail.js";

// REGISTER
// SEND OTP (used for registration)
export const sendOtp = async (req, res) => {
  try {
    const { name, email, password } = req.body;

    const userExists = await User.findOne({ email });

    if (userExists) {
      return res.status(400).json({ message: "Email is already been used" });
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const passwordHash = await bcrypt.hash(password, 10);

    const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

    await Otp.findOneAndUpdate(
      { email },
      { otp, payload: { name, passwordHash }, expiresAt },
      { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
    );

    // Send OTP email
    const subject = "Your Tronites OTP";
    const htmlContent = `<p>Your OTP is <strong>${otp}</strong>. It expires in 5 minutes.</p>`;

    try {
      await sendEmail({ to: email, subject, htmlContent });
    } catch (emailErr) {
      console.error("Brevo send error:", emailErr.message);
      return res.status(502).json({ message: emailErr.message });
    }

    return res.status(200).json({ message: "OTP sent to your email" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// VERIFY OTP and create user
export const verifyOtp = async (req, res) => {
  try {
    const { email, otp } = req.body;

    const otpDoc = await Otp.findOne({ email });

    if (!otpDoc) {
      return res.status(400).json({ message: "OTP not found or expired" });
    }

    if (otpDoc.expiresAt < new Date()) {
      return res.status(400).json({ message: "OTP expired" });
    }

    if (otpDoc.otp !== otp) {
      return res.status(400).json({ message: "Invalid OTP" });
    }

    // Create user from payload
    const { name, passwordHash } = otpDoc.payload || {};

    if (!name || !passwordHash) {
      return res.status(400).json({ message: "Invalid OTP payload" });
    }

    const user = await User.create({ name, email, password: passwordHash });

    // remove otp record
    await Otp.deleteOne({ _id: otpDoc._id });

    // Generate token cookie
    generateToken(res, user._id);

    res.status(201).json({ _id: user._id, name: user.name, email: user.email });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// RESEND OTP
export const resendOtp = async (req, res) => {
  try {
    const { email } = req.body;

    const existing = await Otp.findOne({ email });

    if (!existing) {
      return res.status(400).json({ message: "No pending OTP for this email" });
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

    existing.otp = otp;
    existing.expiresAt = expiresAt;
    await existing.save();

    const subject = "Your Tronites OTP";
    const htmlContent = `<p>Your new OTP is <strong>${otp}</strong>. It expires in 5 minutes.</p>`;

    try {
      await sendEmail({ to: email, subject, htmlContent });
    } catch (emailErr) {
      console.error("Brevo resend error:", emailErr.message);
      return res.status(502).json({ message: emailErr.message });
    }

    res.status(200).json({ message: "OTP resent" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// LOGIN
export const loginUser = async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email });

    if (!user) {
      return res.status(400).json({ message: "User not found" });
    }

    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
      return res.status(400).json({ message: "Invalid credentials" });
    }

    generateToken(res, user._id);

    res.status(200).json({
      _id: user._id,
      name: user.name,
      email: user.email,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

//logout controller
export const logoutUser = (req, res) => {
  res.cookie("token", "", {
    httpOnly: true,
    expires: new Date(0),
  });

  res.status(200).json({ message: "Logged out" });
};

//get current user
export const getMe = async (req, res) => {
  res.status(200).json(req.user);
};
