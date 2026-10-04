import Post from "../models/Post.js";
import AdCampaign from "../models/AdCampaign.js";
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

const clearExpiredPostFields = async () => {
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

// Keeps AdCampaign in step with its posts. Campaign posts don't always carry
// ctaType/destinationUrl, so this can't piggyback on the Post sweep above — it
// reads the campaign's own per-post windows instead.
// Marks each elapsed entry "expired"; once every entry is expired the
// campaign itself becomes "completed". Pass campaignIds to scope the sync.
export const syncCampaignExpiry = async (campaignIds = null) => {
  try {
    const now = new Date();
    const query = { status: "active" };
    if (campaignIds?.length) query._id = { $in: campaignIds };

    const campaigns = await AdCampaign.find(query);
    let completed = 0;

    for (const campaign of campaigns) {
      let dirty = false;

      for (const entry of campaign.posts) {
        if (
          entry.status !== "expired" &&
          entry.promotedUntil &&
          new Date(entry.promotedUntil) <= now
        ) {
          entry.status = "expired";
          dirty = true;
        }
      }

      if (campaign.posts.length && campaign.posts.every((e) => e.status === "expired")) {
        campaign.status = "completed";
        dirty = true;
        completed += 1;
      }

      if (dirty) await campaign.save();
    }

    if (completed) console.log(`[expirePromotions] completed ${completed} ad campaign(s).`);
    return { completed };
  } catch (error) {
    console.error("[expirePromotions] campaign sync failed:", error.message);
    return { completed: 0 };
  }
};

export const expirePromotions = async () => {
  const { expired } = await clearExpiredPostFields();
  const { completed } = await syncCampaignExpiry();
  return { expired, completed };
};
