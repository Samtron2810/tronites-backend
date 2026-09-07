import User from "../models/User.js";
import Notification from "../models/Notification.js";
import { emitToUser } from "../socket/socket.js";
import { pushForNotification } from "../services/pushService.js";

// Runs once daily. Finds creator badges expiring within 14 days and
// sends a push + in-app notification if one hasn't been sent already
// in the last 12 hours for the same badge.
export const runBadgeRenewalReminder = async () => {
  try {
    const now = new Date();
    const in14Days = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
    const cooldownSince = new Date(now.getTime() - 12 * 60 * 60 * 1000);

    const users = await User.find({
      banned: false,
      deletedAt: null,
      verifications: {
        $elemMatch: {
          type: "creator",
          expiresAt: { $gt: now, $lte: in14Days },
        },
      },
    })
      .select("_id verifications")
      .lean();

    let reminded = 0;

    for (const user of users) {
      const badge = user.verifications.find(
        (v) =>
          v.type === "creator" &&
          v.expiresAt &&
          new Date(v.expiresAt) > now &&
          new Date(v.expiresAt) <= in14Days,
      );
      if (!badge) continue;

      // Cooldown: skip if already reminded within 12h
      const recent = await Notification.findOne({
        recipient: user._id,
        type: "badge_expiring",
        createdAt: { $gte: cooldownSince },
      }).lean();
      if (recent) continue;

      const daysLeft = Math.ceil(
        (new Date(badge.expiresAt) - now) / (1000 * 60 * 60 * 24),
      );

      const notif = await Notification.create({
        recipient: user._id,
        sender: null,
        type: "badge_expiring",
        message: `Your Creator badge expires in ${daysLeft} day${daysLeft === 1 ? "" : "s"}. Renew it to keep your analytics and creator tools.`,
      });

      const populated = await notif.populate("recipient", "name username");
      emitToUser(user._id, "newNotification", populated);
      await pushForNotification(user._id, {
        ...populated.toObject(),
        _overrideCopy: {
          title: "Creator badge expiring soon",
          body: `Your badge expires in ${daysLeft} day${daysLeft === 1 ? "" : "s"} — renew to keep creator tools active.`,
        },
      }).catch(() => {});

      reminded++;
    }

    if (reminded) {
      console.log(`[badgeRenewalReminder] Reminded ${reminded} creator(s).`);
    }
  } catch (err) {
    console.error("[badgeRenewalReminder] Error:", err.message);
  }
};
