// Gates routes to accounts whose verification tier allows scheduling —
// every verified tier (individual/creator/business/government/staff) can
// schedule; unverified cannot. Enforcement mirrors the tier lookup in
// utils/tierLimits.js (the createPost/createVideoPost controllers also
// reject a scheduledFor on unverified accounts as defense in depth).
import { canSchedule } from "../utils/tierLimits.js";

const requireScheduling = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ message: "Authentication required." });
  }

  if (!canSchedule(req.user)) {
    return res.status(403).json({
      message: "Scheduling posts requires a verified account.",
      code: "SCHEDULING_UNAVAILABLE",
    });
  }

  next();
};

export default requireScheduling;