// Gates routes to accounts that hold an active "creator" OR "business"
// verification badge.
// Originally creator-only; extended to business so business accounts
// get the same analytics visibility as creators (they arguably need
// it more). Staff always passes.
const requireCreatorOrBusiness = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ message: "Authentication required." });
  }

  const now = new Date();
  const ALLOWED_TYPES = new Set(["creator", "business", "staff"]);
  const hasBadge = (req.user.verifications || []).some(
    (v) =>
      ALLOWED_TYPES.has(v.type) &&
      (!v.expiresAt || new Date(v.expiresAt) > now),
  );

  if (!hasBadge) {
    return res.status(403).json({
      message: "Creator or Business account required.",
      code: "NOT_CREATOR_OR_BUSINESS",
    });
  }

  next();
};

// Strict creator-only (used for monetization routes that are specific
// to the creator tier: subscription plans, subscriber list, earnings).
export const requireCreator = (req, res, next) => {
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

// Default export is the broader analytics gate (creator OR business OR staff).
export default requireCreatorOrBusiness;
