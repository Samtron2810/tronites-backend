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

    // Soft-deleted accounts are rejected the same as if they didn't
    // exist — see User.deletedAt. The row survives until the purge job
    // hard-deletes it (grace window for reversal), but nothing should
    // treat a pending-deletion account as usable in the meantime.
    if (req.user.deletedAt) {
      return res.status(401).json({
        message: "This account has been deleted",
      });
    }

    // Session invalidation after a password change/reset. JWTs carry an
    // `iat` (issued-at) claim; if the password was changed after this
    // token was issued, the token represents a session from before the
    // change and is rejected. This makes a password reset (or a future
    // "change password" setting) revoke every previously-issued token —
    // including a stolen cookie — with no server-side session store.
    if (
      req.user.passwordChangedAt &&
      decoded.iat * 1000 < new Date(req.user.passwordChangedAt).getTime()
    ) {
      return res.status(401).json({
        message: "Not authorized, token failed",
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
