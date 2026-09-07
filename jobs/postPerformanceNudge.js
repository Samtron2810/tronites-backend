import User from "../models/User.js";
import Notification from "../models/Notification.js";
import { emitToUser } from "../socket/socket.js";
import { pushForNotification } from "../services/pushService.js";
import { getUnderperformingPost } from "../controllers/analyticsController.js";

// Runs every 6 hours. For each verified creator who posted in the last
// 24h, checks if their most recent post is below 30% of their historical
// average engagement. If so, creates a system notification + push nudge
// so the creator knows to re-share, add a comment, or promote the post.
//
// Gated by a 24h cooldown per creator (tracked on the notification itself)
// so we never spam the same person twice for the same underperformance.
export const runPostPerformanceNudge = async () => {
  try {
    const now = new Date();
    const cooldownSince = new Date(now - 24 * 60 * 60 * 1000);

    // Only active verified creators
    const creators = await User.find({
      banned: false,
      deletedAt: null,
      "verifications.type": "creator",
      $or: [
        { "verifications.expiresAt": null },
        { "verifications.expiresAt": { $gt: now } },
      ],
    })
      .select("_id")
      .lean();

    let nudged = 0;

    for (const creator of creators) {
      // Cooldown: skip if we already nudged them in the last 24h
      const recentNudge = await Notification.findOne({
        recipient: creator._id,
        type: "moderator_warning", // reusing type slot — see comment below
        message: { $regex: /^__perf_nudge__/ },
        createdAt: { $gte: cooldownSince },
      }).lean();
      if (recentNudge) continue;

      const post = await getUnderperformingPost(creator._id);
      if (!post) continue;

      const snippet =
        post.text?.slice(0, 60) ||
        (post.images?.length ? "Your image post" : "Your video post");

      // We use `moderator_warning` type with a sentinel prefix in
      // `message` so we can query it as a cooldown marker without
      // adding a new Notification enum type. The notification is NOT
      // displayed as a warning in the UI — the frontend checks for
      // the __perf_nudge__ prefix and renders it as a creator insight
      // card instead.
      const notif = await Notification.create({
        recipient: creator._id,
        sender: null,
        type: "moderator_warning",
        message: `__perf_nudge__${snippet}`,
      });

      const populated = await notif.populate("recipient", "name username");
      emitToUser(creator._id, "newNotification", populated);
      await pushForNotification(creator._id, {
        ...populated.toObject(),
        _overrideCopy: {
          title: "Post performance tip",
          body: `"${snippet.slice(0, 50)}…" is getting less traction than usual. Consider re-sharing or adding a comment.`,
        },
      }).catch(() => {});

      nudged++;
    }

    if (nudged) console.log(`[postPerformanceNudge] Nudged ${nudged} creator(s).`);
  } catch (err) {
    console.error("[postPerformanceNudge] Error:", err.message);
  }
};
