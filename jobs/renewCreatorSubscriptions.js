// Runs nightly. Finds active subscriptions whose currentPeriodEnd is within
// the next 24 hours and attempts to charge the stored Paystack authorization
// code. On success: extends currentPeriodEnd by 30 days and records the charge
// in the CreatorTip ledger. On failure: marks the subscription "failed" and
// notifies both parties.
//
// Paystack charge-authorization (recurring) uses POST /charge/authorization,
// which is a direct server-to-server charge without a checkout redirect.
// Requires that the subscriber completed their first payment through a
// standard Paystack checkout (where Paystack returns an authorization_code).

import https from "https";
import { CreatorSubscription, CreatorPlan } from "../models/CreatorSubscription.js";
import CreatorTip from "../models/CreatorTip.js";
import Notification from "../models/Notification.js";
import User from "../models/User.js";
import { emitToUser } from "../socket/socket.js";
import { invalidateCache } from "../utils/redis.js";

const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY;

const paystackPost = (path, body) =>
  new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const options = {
      hostname: "api.paystack.co",
      port: 443,
      path,
      method: "POST",
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch { reject(new Error("Invalid Paystack response")); }
      });
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });

const chargeAuthorization = async ({ authCode, email, amountKobo, reference, metadata }) => {
  if (!PAYSTACK_SECRET) throw new Error("PAYSTACK_SECRET_KEY not configured.");
  const res = await paystackPost("/charge/authorization", {
    authorization_code: authCode,
    email,
    amount: amountKobo,
    reference,
    metadata: metadata || {},
  });
  if (!res.status) throw new Error(res.message || "Charge failed.");
  return res.data;
};

export const renewCreatorSubscriptions = async () => {
  if (!PAYSTACK_SECRET) {
    console.warn("[renewCreatorSubscriptions] PAYSTACK_SECRET_KEY not set — skipping.");
    return;
  }

  const now = new Date();
  const renewalWindow = new Date(now.getTime() + 24 * 60 * 60 * 1000); // next 24h

  // Find active subs due for renewal that have a stored auth code.
  const dueSubs = await CreatorSubscription.find({
    status: "active",
    currentPeriodEnd: { $lte: renewalWindow },
    paystackAuthCode: { $ne: null },
  })
    .populate("plan", "priceNgn name")
    .lean();

  if (dueSubs.length === 0) return;
  console.log(`[renewCreatorSubscriptions] ${dueSubs.length} subscription(s) due for renewal.`);

  for (const sub of dueSubs) {
    try {
      const reference = `tronites_renewal_${sub._id}_${Date.now()}`;
      const amountKobo = (sub.plan?.priceNgn || 0) * 100;

      if (amountKobo === 0) {
        console.warn(`[renewCreatorSubscriptions] Sub ${sub._id} has zero-price plan — skipping.`);
        continue;
      }

      const chargeData = await chargeAuthorization({
        authCode: sub.paystackAuthCode,
        email: sub.subscriberEmail,
        amountKobo,
        reference,
        metadata: {
          flow: "subscription_renewal",
          subscriptionId: sub._id.toString(),
          subscriberId: sub.subscriber.toString(),
          creatorId: sub.creator.toString(),
        },
      });

      if (chargeData?.status === "success") {
        const newPeriodEnd = new Date(sub.currentPeriodEnd.getTime() + 30 * 24 * 60 * 60 * 1000);

        await CreatorSubscription.findByIdAndUpdate(sub._id, {
          $set: {
            currentPeriodEnd: newPeriodEnd,
            lastChargeReference: reference,
            lastChargedAt: now,
            status: "active",
          },
        });

        // Record charge in earnings ledger
        await CreatorTip.create({
          sender: sub.subscriber,
          creator: sub.creator,
          post: null,
          amountKobo,
          reference,
          status: "verified",
          message: `Monthly subscription renewal — ${sub.plan?.name || ""}`,
          isAnonymous: false,
        });

        invalidateCache(`creator-earnings:${sub.creator}`);
        invalidateCache(`sub-status:${sub.subscriber}:${sub.creator}`);

        // Notify subscriber
        const subNotif = await Notification.create({
          recipient: sub.subscriber,
          sender: null,
          type: "creator_subscribe",
          message: `Your subscription was renewed. Next billing: ${newPeriodEnd.toLocaleDateString()}.`,
        });
        emitToUser(sub.subscriber.toString(), "newNotification", subNotif);

      } else {
        // Charge didn't immediately succeed — mark failed, notify both parties
        await CreatorSubscription.findByIdAndUpdate(sub._id, {
          $set: { status: "failed" },
        });

        invalidateCache(`sub-status:${sub.subscriber}:${sub.creator}`);

        const [subUser, creatorUser] = await Promise.all([
          User.findById(sub.subscriber).select("name").lean(),
          User.findById(sub.creator).select("name").lean(),
        ]);

        const failNotifSubscriber = await Notification.create({
          recipient: sub.subscriber,
          sender: null,
          type: "creator_subscribe",
          message: `Your subscription to ${creatorUser?.name || "a creator"} could not be renewed. Please resubscribe.`,
        });
        emitToUser(sub.subscriber.toString(), "newNotification", failNotifSubscriber);

        const failNotifCreator = await Notification.create({
          recipient: sub.creator,
          sender: null,
          type: "creator_subscribe",
          message: `${subUser?.name || "A subscriber"}'s subscription renewal failed.`,
        });
        emitToUser(sub.creator.toString(), "newNotification", failNotifCreator);
      }
    } catch (err) {
      console.error(`[renewCreatorSubscriptions] Error processing sub ${sub._id}:`, err.message);
      // Don't mark failed on a network error — retry on next run.
    }
  }

  // Clean up subscriptions that are cancelled and past their currentPeriodEnd.
  await CreatorSubscription.updateMany(
    {
      status: { $in: ["cancelled", "failed"] },
      currentPeriodEnd: { $lt: now },
    },
    { $set: { status: "expired" } },
  );
};
