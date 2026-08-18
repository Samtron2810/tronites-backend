// Gates moderation-only routes. Must run after `protect` (needs
// req.user already populated). role isn't in toPublicUserDTO/
// toPrivateSelfDTO — it's an authorization flag, not profile data — so
// this middleware reads it directly off req.user rather than a DTO.
const requireModerator = (req, res, next) => {
  if (!req.user || !["moderator", "admin"].includes(req.user.role)) {
    return res.status(403).json({ message: "Moderator access required." });
  }
  next();
};

export default requireModerator;
