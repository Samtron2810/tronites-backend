import User from "../models/User.js";
import Notification from "../models/Notification.js";
import { emitToUser } from "../socket/socket.js";

// Phase 5 — nightly badge expiry sweep.
// Finds users with at least one verification whose expiresAt has passed,
// strips those entries, recomputes isVerified, and fires a
// verification_expired in-app notification so the user knows to reapply.
//
// Only business and creator badges carry an expiresAt (set to +1 year at
// grant time). Individual and government are perpetual. The query is
// index-backed (verifications.expiresAt is indexed on User) so this is a
// cheap no-op on nights where nothing has lapsed.
//
// A crash mid-sweep is safe: the next nightly run re-matches the same
// users (their verifications still have the past expiresAt), so no
// notification is lost — it just fires slightly late.

const BADGE_LABELS = {
  individual: "Individual",
  business: "Business",
  government: "Government",
  creator: "Creator",
  staff: "Staff",
};

const fireExpiredNotification = async (userId, expiredTypes) => {
  try {
    const labelList = expiredTypes
      .map((t) => BADGE_LABELS[t] || t)
      .join(" and ");
    const plural = expiredTypes.length > 1;
    const notif = await Notification.create({
      recipient: userId,
      sender: null, // system-generated — no human sender
      type: "verification_expired",
      message: `Your ${labelList} verification badge${plural ? "s have" : " has"} expired. Reapply in Settings → Verification to reinstate your badge.`,
    });
    // Attempt real-time delivery; silently skip if user is offline.
    emitToUser(userId, "newNotification", notif);
  } catch (e) {
    console.error(
      `[expireVerifications] notification failed for user ${userId}:`,
      e.message,
    );
  }
};

export const expireVerifications = async () => {
  try {
    const now = new Date();

    // Only users who have at least one expired entry — index hit only.
    const affected = await User.find({
      "verifications.expiresAt": { $lte: now },
    }).select("_id verifications isVerified");

    if (!affected.length) return { usersUpdated: 0, badgesExpired: 0 };

    let usersUpdated = 0;
    let badgesExpired = 0;

    for (const user of affected) {
      const expiredTypes = [];

      user.verifications = user.verifications.filter((v) => {
        if (v.expiresAt && new Date(v.expiresAt) <= now) {
          expiredTypes.push(v.type);
          badgesExpired++;
          return false;
        }
        return true;
      });

      if (!expiredTypes.length) continue;

      user.isVerified = user.verifications.length > 0;
      await user.save();
      usersUpdated++;

      await fireExpiredNotification(user._id, expiredTypes);
    }

    if (usersUpdated > 0) {
      console.log(
        `[expireVerifications] ${badgesExpired} badge(s) expired across ${usersUpdated} user(s).`,
      );
    }

    return { usersUpdated, badgesExpired };
  } catch (error) {
    // Never crash the process — background sweep must be fault-tolerant.
    console.error("[expireVerifications] sweep failed:", error.message);
    return { usersUpdated: 0, badgesExpired: 0 };
  }
};
