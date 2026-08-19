// Gates admin-only routes (role management). Stricter than
// requireModerator — moderators can act on reports, but granting or
// revoking moderator/admin status is admin-only, otherwise a moderator
// could promote themselves or peers to admin.
const requireAdmin = (req, res, next) => {
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({ message: "Admin access required." });
  }
  next();
};

export default requireAdmin;
