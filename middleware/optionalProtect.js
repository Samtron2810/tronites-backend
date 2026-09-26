import jwt from "jsonwebtoken";
import User from "../models/User.js";

// Same identity/eligibility checks as protect (authMiddleware.js), but a
// missing or invalid token is not an error here — req.user is simply left
// undefined and the request continues anonymously. Only use this on public
// GET endpoints that are meant to work for both visitors and logged-in
// users; never on a mutation (those must stay behind protect).
const optionalProtect = async (req, res, next) => {
  try {
    const token = req.cookies.token;

    if (!token) {
      req.user = undefined;
      return next();
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.userId).select("-password");

    // Any of these states means "treat this request as anonymous" rather
    // than "reject it" — a public GET should still render for a visitor
    // whose own session happens to be stale/invalid, exactly as it would
    // for someone with no cookie at all. Mirrors protect's checks; only
    // the failure behavior (continue vs. 401/403) differs.
    if (
      !user ||
      user.deletedAt ||
      user.banned ||
      (user.suspendedUntil && new Date(user.suspendedUntil) > new Date()) ||
      (user.passwordChangedAt &&
        decoded.iat * 1000 < new Date(user.passwordChangedAt).getTime())
    ) {
      req.user = undefined;
      return next();
    }

    req.user = user;
    next();
  } catch {
    // Malformed/expired token — same rule: anonymous, not an error.
    req.user = undefined;
    next();
  }
};

export default optionalProtect;
