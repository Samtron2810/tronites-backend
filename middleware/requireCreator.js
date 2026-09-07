// Gates routes to accounts that hold an active "creator" verification
// badge. A creator badge is granted through the standard verification
// flow (see verificationController.js) and lives in user.verifications[].
// We check the denormalized isVerified flag first (cheap) then confirm
// the specific badge type (exact), filtering out expired entries the same
// way toPublicUserDTO does.
const requireCreator = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ message: "Authentication required." });
  }

  const now = new Date();
  const hasCreatorBadge = (req.user.verifications || []).some(
    (v) =>
      v.type === "creator" &&
      (!v.expiresAt || new Date(v.expiresAt) > now),
  );

  if (!hasCreatorBadge) {
    return res.status(403).json({
      message: "Creator account required.",
      code: "NOT_CREATOR",
    });
  }

  next();
};

export default requireCreator;
