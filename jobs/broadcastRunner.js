import EmailCampaign from "../models/EmailCampaign.js";
import EmailCampaignRecipient from "../models/EmailCampaignRecipient.js";
import { sendEmail } from "../utils/brevoEmail.js";
import { renderCampaignEmail } from "../services/broadcastService.js";

// DB-backed sender: campaign + per-recipient rows live in Mongo, so a
// restart or redeploy resumes exactly where it stopped and Redis isn't
// required. Recipients are claimed atomically, so two instances can't
// double-send the same row.
const SEND_DELAY_MS = Number(process.env.BROADCAST_SEND_DELAY_MS) || 250;
const STALE_CLAIM_MS = 2 * 60 * 1000;
const MAX_ATTEMPTS = 2;
// Provider limit / throttle → pause the campaign instead of burning
// through every recipient as "failed".
const QUOTA_ERROR = /\b(402|429)\b|quota|daily limit|rate limit|too many requests|account.*(suspend|blocked)/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let running = false;

export const runBroadcastTick = async () => {
  if (running) return;
  running = true;
  try {
    await EmailCampaignRecipient.updateMany(
      { status: "sending", claimedAt: { $lt: new Date(Date.now() - STALE_CLAIM_MS) } },
      { $set: { status: "pending" } },
    );

    const campaign = await EmailCampaign.findOneAndUpdate(
      { status: { $in: ["queued", "sending"] } },
      { $set: { status: "sending" } },
      { sort: { createdAt: 1 }, returnDocument: 'after' },
    );
    if (!campaign) return;
    if (!campaign.startedAt) {
      await EmailCampaign.updateOne({ _id: campaign._id }, { $set: { startedAt: new Date() } });
    }

    while (true) {
      const live = await EmailCampaign.findById(campaign._id).select("status").lean();
      if (!live || live.status !== "sending") break;

      const rcpt = await EmailCampaignRecipient.findOneAndUpdate(
        { campaign: campaign._id, status: "pending" },
        { $set: { status: "sending", claimedAt: new Date() }, $inc: { attempts: 1 } },
        { sort: { _id: 1 }, returnDocument: 'after' },
      );

      if (!rcpt) {
        const inFlight = await EmailCampaignRecipient.countDocuments({
          campaign: campaign._id,
          status: "sending",
        });
        if (inFlight === 0) {
          const done = await EmailCampaign.findOneAndUpdate(
            { _id: campaign._id, status: "sending" },
            { $set: { completedAt: new Date() } },
            { returnDocument: 'after' },
          );
          if (done) {
            done.status = done.sentCount === 0 ? "failed" : "completed";
            await done.save();
          }
        }
        break;
      }

      try {
        const { subject, html, unsubscribeUrl } = renderCampaignEmail(campaign, {
          userId: rcpt.user,
          firstName: rcpt.firstName,
        });
        await sendEmail({
          to: rcpt.email,
          subject,
          htmlContent: html,
          headers: unsubscribeUrl ? { "List-Unsubscribe": `<${unsubscribeUrl}>` } : undefined,
        });
        await EmailCampaignRecipient.updateOne(
          { _id: rcpt._id },
          { $set: { status: "sent", sentAt: new Date(), error: "" } },
        );
        await EmailCampaign.updateOne({ _id: campaign._id }, { $inc: { sentCount: 1 } });
      } catch (err) {
        const message = String(err?.message || err).slice(0, 300);

        if (QUOTA_ERROR.test(message)) {
          await EmailCampaignRecipient.updateOne(
            { _id: rcpt._id },
            { $set: { status: "pending" }, $inc: { attempts: -1 } },
          );
          await EmailCampaign.updateOne(
            { _id: campaign._id, status: "sending" },
            { $set: { status: "paused", lastError: message } },
          );
          console.error("Broadcast paused (provider limit):", message);
          break;
        }

        if (rcpt.attempts < MAX_ATTEMPTS) {
          await EmailCampaignRecipient.updateOne(
            { _id: rcpt._id },
            { $set: { status: "pending", error: message } },
          );
        } else {
          await EmailCampaignRecipient.updateOne(
            { _id: rcpt._id },
            { $set: { status: "failed", error: message } },
          );
          await EmailCampaign.updateOne(
            { _id: campaign._id },
            { $inc: { failedCount: 1 }, $set: { lastError: message } },
          );
        }
      }

      await sleep(SEND_DELAY_MS);
    }
  } catch (err) {
    console.error("broadcast runner error:", err.message);
  } finally {
    running = false;
  }
};
