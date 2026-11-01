import { CreatorPayout } from "../models/CreatorPayout.js";
import { invalidateCache } from "../utils/redis.js";

// Shared by the Paystack transfer webhook and the admin "sync" action so
// both resolve a payout the same way. Both only act on payouts that are
// currently "processing", which makes repeated webhook deliveries (and a
// webhook racing a manual sync) idempotent.

export const payoutReferenceFor = (payoutId) => `tronites_payout_${payoutId}`;

export const markPayoutPaid = async (reference) => {
  const payout = await CreatorPayout.findOneAndUpdate(
    { paystackReference: reference, status: "processing" },
    {
      $set: {
        status: "paid",
        paystackStatus: "success",
        resolvedAt: new Date(),
        failureReason: "",
      },
    },
    { returnDocument: "after" },
  );
  if (payout) invalidateCache(`creator-earnings:${payout.creator}`);
  return payout;
};

// Failed / reversed transfers release the held balance: "failed" payouts are
// not counted by computeEarnings, so the creator can request again.
export const markPayoutFailed = async (reference, paystackStatus, reason) => {
  const payout = await CreatorPayout.findOneAndUpdate(
    { paystackReference: reference, status: "processing" },
    {
      $set: {
        status: "failed",
        paystackStatus: paystackStatus || "failed",
        resolvedAt: new Date(),
        failureReason: String(reason || "Transfer failed.").slice(0, 300),
      },
    },
    { returnDocument: "after" },
  );
  if (payout) invalidateCache(`creator-earnings:${payout.creator}`);
  return payout;
};
