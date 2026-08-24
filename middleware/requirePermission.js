import { DEFAULT_MODERATOR_PERMISSIONS } from "../models/User.js";

// Phase 5 — granular permission gate, the successor to piecemeal
// role checks on moderation routes. Must run after `protect`.
//
// Resolution order:
//   1. admin role        → implicit wildcard (short-circuit)
//   2. explicit non-empty permissions array → authoritative, even when it
//      WITHHOLDS something a moderator would get by default — this is
//      what makes revocation possible
//   3. moderator with empty array → DEFAULT_MODERATOR_PERMISSIONS, so
//      pre-granular rows and freshly promoted ones keep exactly the
//      capabilities Phases 2–4 gave them
//   4. everyone else     → 403 with the missing permission named
const requirePermission = (permission) => (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ message: "Not authorized, no user" });
  }
  if (req.user.role === "admin") return next();

  const effective = req.user.permissions?.length
    ? req.user.permissions
    : req.user.role === "moderator"
      ? DEFAULT_MODERATOR_PERMISSIONS
      : [];

  if (effective.includes(permission)) return next();
  return res.status(403).json({ message: `Missing permission: ${permission}` });
};

export default requirePermission;