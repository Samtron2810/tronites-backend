import Post from "../models/Post.js";
import { invalidateFeedCache, invalidateCache } from "../utils/redis.js";

// Sweeps posts whose promotedUntil has passed but which still carry
// promotion fields (ctaType, destinationUrl, promotionSource, promotedBy).
// getMyPromotions/adminListPromotions already DERIVE status "expired" from
// promotedUntil at read time, but nothing previously cleared the post's own
// fields on expiry — so PostCard kept rendering the CTA button (gated only
// on ctaType, not on promotedUntil) until an admin manually ran
// adminCancelPromotion. This job makes expiry self-healing instead of
// depending on manual moderator cleanup.
//
// promotedUntil itself is left in place (kept as promotion history /
// "when did this last run" — adminExtendPromotion and the promotions UI
// both still read it), only the fields that drive active-promotion UI
// and payouts/campaign accounting are cleared.
//
// Runs on the same 60s cadence as publishScheduledPosts — a stuck CTA
// button is user-visible, not a nightly-cadence concern.

export const expirePromotions = async () => {
  try {
    const now = new Date();

    const affected = await Post.find({
      promotedUntil: { $ne: null, $lte: now },
      $or: [
        { ctaType: { $ne: null } },
        { destinationUrl: { $ne: null } },
        { promotionSource: { $ne: null } },
        { promotedBy: { $ne: null } },
      ],
    }).select("user");

    if (!affected.length) return { expired: 0 };

    const postIds = affected.map((p) => p._id);
    const userIds = [...new Set(affected.map((p) => p.user.toString()))];

    await Post.updateMany(
      { _id: { $in: postIds } },
      {
        $set: {
          ctaType: null,
          destinationUrl: null,
          promotionSource: null,
          promotedBy: null,
        },
      },
    );

    for (const userId of userIds) {
      invalidateFeedCache(userId);
      invalidateCache(`profile-posts:${userId}:*`);
    }

    console.log(`[expirePromotions] cleared ${affected.length} expired promotion(s).`);
    return { expired: affected.length };
  } catch (error) {
    // Never crash the process — background sweep must be fault-tolerant.
    console.error("[expirePromotions] sweep failed:", error.message);
    return { expired: 0 };
  }
};
