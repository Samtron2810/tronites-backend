import mongoose from "mongoose";
import User from "../models/User.js";
import EmailCampaign from "../models/EmailCampaign.js";
import EmailCampaignRecipient from "../models/EmailCampaignRecipient.js";
import { sendEmail } from "../utils/brevoEmail.js";
import { logAudit } from "../utils/auditLogger.js";
import {
  MAX_BROADCAST_RECIPIENTS,
  buildAudienceFilter,
  getQuota,
  renderCampaignEmail,
  verifyUnsubscribeToken,
} from "../services/broadcastService.js";

const ACTIVE_STATUSES = ["preparing", "queued", "sending", "paused"];
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// POST /admin/broadcasts/preview — live recipient count + quota.
export const previewAudience = async (req, res) => {
  const { groups, userIds, type } = req.body;
  const filter = buildAudienceFilter({ groups, userIds, type });
  const quota = await getQuota();
  if (!filter) return res.json({ count: 0, sample: [], quota });

  const [count, sample] = await Promise.all([
    User.countDocuments(filter),
    User.find(filter).select("name username profilePic").limit(5).lean(),
  ]);
  res.json({ count, sample, quota, max: MAX_BROADCAST_RECIPIENTS });
};

// POST /admin/broadcasts/render — HTML preview of the exact email.
export const renderPreview = async (req, res) => {
  const { subject, body, ctaLabel, ctaUrl, type } = req.body;
  const { html } = renderCampaignEmail(
    {
      type,
      subject: subject || "Your subject line",
      body: body || "Your message will appear here.",
      ctaLabel,
      ctaUrl,
    },
    { userId: null, firstName: req.user.firstName || "there" },
  );
  res.json({ html });
};

// GET /admin/broadcasts/users/search?q= — single-recipient picker.
export const searchRecipients = async (req, res) => {
  const q = String(req.query.q || "").trim().slice(0, 40);
  if (q.length < 2) return res.json({ users: [] });
  const rx = new RegExp(escapeRegex(q), "i");
  const users = await User.find({
    deletedAt: null,
    banned: { $ne: true },
    $or: [{ username: rx }, { name: rx }, { email: rx }],
  })
    .select("name username email profilePic")
    .limit(8)
    .lean();
  res.json({ users });
};

// POST /admin/broadcasts/test — sends the email to the sender only.
export const sendTest = async (req, res) => {
  const campaign = { ...req.body };
  const { subject, html } = renderCampaignEmail(campaign, {
    userId: req.user._id,
    firstName: req.user.firstName,
  });
  await sendEmail({ to: req.user.email, subject: `[TEST] ${subject}`, htmlContent: html });
  res.json({ message: `Test email sent to ${req.user.email}` });
};

// POST /admin/broadcasts — snapshot recipients, queue the campaign.
export const createBroadcast = async (req, res) => {
  const { groups, userIds, type, subject, body, ctaLabel, ctaUrl } = req.body;

  if (type === "announcement" && !process.env.BACKEND_PUBLIC_URL) {
    return res.status(500).json({
      message: "BACKEND_PUBLIC_URL is not set — announcements need it for the unsubscribe link.",
    });
  }

  const filter = buildAudienceFilter({ groups, userIds, type });
  const count = await User.countDocuments(filter);
  if (count === 0) {
    return res.status(400).json({ message: "No recipients match this audience." });
  }
  if (count > MAX_BROADCAST_RECIPIENTS) {
    return res.status(400).json({
      message: `Audience too large (${count}). Maximum is ${MAX_BROADCAST_RECIPIENTS} per broadcast.`,
    });
  }

  const quota = await getQuota();
  if (count > quota.available) {
    return res.status(409).json({
      message: `Only ${quota.available} sends are available right now (daily limit ${quota.limit}, ${quota.reserve} reserved for OTP and security emails). Narrow the audience or try later.`,
      quota,
    });
  }

  const inFlight = await EmailCampaign.exists({ status: { $in: ACTIVE_STATUSES } });
  if (inFlight) {
    return res.status(409).json({
      message: "Another broadcast is still sending. Wait for it to finish or cancel it first.",
    });
  }

  const campaign = await EmailCampaign.create({
    subject,
    body,
    ctaLabel,
    ctaUrl,
    type,
    audience: { groups, userIds },
    status: "preparing",
    recipientCount: count,
    createdBy: {
      _id: req.user._id,
      name: req.user.name,
      username: req.user.username || null,
    },
  });

  try {
    let batch = [];
    let inserted = 0;
    const flush = async () => {
      if (!batch.length) return;
      await EmailCampaignRecipient.insertMany(batch, { ordered: false });
      inserted += batch.length;
      batch = [];
    };
    const cursor = User.find(filter).select("email firstName").lean().cursor();
    for await (const u of cursor) {
      batch.push({
        campaign: campaign._id,
        user: u._id,
        email: u.email,
        firstName: u.firstName || "",
      });
      if (batch.length >= 500) await flush();
    }
    await flush();

    campaign.recipientCount = inserted;
    campaign.status = inserted > 0 ? "queued" : "failed";
    await campaign.save();
  } catch (err) {
    await EmailCampaignRecipient.deleteMany({ campaign: campaign._id });
    campaign.status = "failed";
    campaign.lastError = err.message.slice(0, 300);
    await campaign.save();
    return res.status(500).json({ message: "Could not prepare recipients." });
  }

  logAudit({
    action: "email_broadcast_created",
    actor: req.user,
    target: {
      type: "campaign",
      ref: campaign._id,
      snapshot: { subject: campaign.subject },
    },
    detail: {
      groups,
      userIds: userIds.length,
      type,
      recipientCount: campaign.recipientCount,
    },
    req,
  });

  res.status(201).json({ campaign });
};

// GET /admin/broadcasts?page=
export const listBroadcasts = async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = 15;
  const [campaigns, total] = await Promise.all([
    EmailCampaign.find()
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .select("-body")
      .lean(),
    EmailCampaign.countDocuments(),
  ]);
  res.json({ campaigns, page, pages: Math.max(1, Math.ceil(total / limit)), total });
};

// GET /admin/broadcasts/:id
export const getBroadcast = async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(404).json({ message: "Broadcast not found." });
  }
  const campaign = await EmailCampaign.findById(req.params.id).lean();
  if (!campaign) return res.status(404).json({ message: "Broadcast not found." });

  const failures = await EmailCampaignRecipient.find({
    campaign: campaign._id,
    status: "failed",
  })
    .select("email error")
    .limit(25)
    .lean();
  res.json({ campaign, failures });
};

// POST /admin/broadcasts/:id/cancel
export const cancelBroadcast = async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(404).json({ message: "Broadcast not found." });
  }
  const campaign = await EmailCampaign.findOneAndUpdate(
    { _id: req.params.id, status: { $in: ACTIVE_STATUSES } },
    { $set: { status: "cancelled", completedAt: new Date() } },
    { new: true },
  );
  if (!campaign) {
    return res.status(409).json({ message: "This broadcast is not running." });
  }
  // Frees the unsent share of the daily quota immediately.
  await EmailCampaignRecipient.updateMany(
    { campaign: campaign._id, status: "pending" },
    { $set: { status: "cancelled" } },
  );

  logAudit({
    action: "email_broadcast_cancelled",
    actor: req.user,
    target: { type: "campaign", ref: campaign._id, snapshot: { subject: campaign.subject } },
    detail: { sentCount: campaign.sentCount, recipientCount: campaign.recipientCount },
    req,
  });
  res.json({ campaign });
};

// POST /admin/broadcasts/:id/resume — paused campaigns only.
export const resumeBroadcast = async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(404).json({ message: "Broadcast not found." });
  }
  const campaign = await EmailCampaign.findOneAndUpdate(
    { _id: req.params.id, status: "paused" },
    { $set: { status: "queued", lastError: "" } },
    { new: true },
  );
  if (!campaign) return res.status(409).json({ message: "This broadcast is not paused." });
  res.json({ campaign });
};

// GET /api/unsubscribe?token= — public, linked from announcement emails.
export const unsubscribe = async (req, res) => {
  const page = (title, msg) =>
    `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f5f5f5;font-family:Arial,Helvetica,sans-serif;"><div style="max-width:420px;margin:24px;background:#fff;border-radius:16px;padding:36px 28px;text-align:center;box-shadow:0 4px 12px rgba(0,0,0,.1);"><h1 style="margin:0 0 6px;font-size:26px;color:#0f6e56;">Tronites</h1><h2 style="margin:18px 0 8px;font-size:18px;color:#111827;">${title}</h2><p style="margin:0;font-size:14px;line-height:1.6;color:#6b7280;">${msg}</p></div></body></html>`;

  try {
    const userId = verifyUnsubscribeToken(String(req.query.token || ""));
    await User.updateOne({ _id: userId }, { $set: { marketingEmailOptOut: true } });
    res
      .status(200)
      .type("html")
      .send(
        page(
          "You're unsubscribed",
          "You won't receive announcement emails from Tronites anymore. Important account and security notices may still reach you.",
        ),
      );
  } catch {
    res
      .status(400)
      .type("html")
      .send(page("Link not valid", "This unsubscribe link is invalid or has been altered."));
  }
};
