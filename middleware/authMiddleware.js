import jwt from "jsonwebtoken";
import User from "../models/User.js";

const protect = async (req, res, next) => {
  try {
    const token = req.cookies.token;

    // No Token
    if (!token) {
      return res.status(401).json({
        message: "Not authorized, no token",
      });
    }

    // Verify Token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Get User
    req.user = await User.findById(decoded.userId).select("-password");

    if (!req.user) {
      return res.status(401).json({
        message: "User no longer exists",
      });
    }

    next();
  } catch (error) {
    res.status(401).json({
      message: "Not authorized, token failed",
    });
  }
};

export default protect;
