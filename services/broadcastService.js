import jwt from "jsonwebtoken";
import User from "../models/User.js";
import EmailCampaignRecipient from "../models/EmailCampaignRecipient.js";
import { broadcastEmailTemplate } from "../utils/emailTemplate.js";

export const MAX_BROADCAST_RECIPIENTS = 5000;

// Same precedence as utils/tierLimits.js TIER_PRIORITY.
const TIER_PRIORITY = ["staff", "government", "business", "creator", "individual"];

const notExpired = (now) => ({ $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] });
const hasActive = (type, now) => ({
  verifications: { $elemMatch: { type, ...notExpired(now) } },
});
const hasAnyActive = (now) => ({ verifications: { $elemMatch: notExpired(now) } });

// A user's tier is their HIGHEST active badge (getActiveTier), so a
// "creator" recipient is someone whose top active badge is creator — not
// every business account that also happens to hold a creator badge.
const tierClause = (tier, now) => {
  const higher = TIER_PRIORITY.slice(0, TIER_PRIORITY.indexOf(tier));
  return { $and: [hasActive(tier, now), ...higher.map((h) => ({ $nor: [hasActive(h, now)] }))] };
};

const groupClause = (key, now) => {
  switch (key) {
    case "verified":
      return hasAnyActive(now);
    case "unverified":
      return { $nor: [hasAnyActive(now)] };
    case "users":
      return { role: "user" };
    case "moderators":
      return { role: "moderator" };
    case "admins":
      return { role: "admin" };
    default:
      return tierClause(key, now);
  }
};

/**
 * Mongo filter for the chosen audience, or null when nothing is selected.
 * Banned and deleted accounts never receive broadcasts. Opt-outs are
 * honoured for groups on "announcement" sends; individually picked users
 * are a deliberate one-to-one choice and are not filtered by opt-out.
 */
export const buildAudienceFilter = ({ groups = [], userIds = [], type = "announcement" }) => {
  const now = new Date();
  const optOutGuard = type === "critical" ? {} : { marketingEmailOptOut: { $ne: true } };
  const clauses = [];

  if (groups.includes("all")) {
    clauses.push(optOutGuard);
  } else {
    for (const g of groups) clauses.push({ $and: [groupClause(g, now), optOutGuard] });
  }
  if (userIds.length) clauses.push({ _id: { $in: userIds } });
  if (!clauses.length) return null;

  return { deletedAt: null, banned: { $ne: true }, $or: clauses };
};

/**
 * Brevo's free plan caps sends per day, and OTP/security emails share that
 * quota. Available = limit − reserve (kept for transactional mail) − what
 * was already sent in the last 24h − what is still queued.
 */
export const getQuota = async () => {
  const limit = Number(process.env.BREVO_DAILY_LIMIT) || 300;
  const reserve = Number(process.env.BROADCAST_DAILY_RESERVE) || 60;
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [sentLast24h, queued] = await Promise.all([
    EmailCampaignRecipient.countDocuments({ status: "sent", sentAt: { $gte: since } }),
    EmailCampaignRecipient.countDocuments({ status: { $in: ["pending", "sending"] } }),
  ]);
  return {
    limit,
    reserve,
    sentLast24h,
    queued,
    available: Math.max(0, limit - reserve - sentLast24h - queued),
  };
};

// ── Rendering ────────────────────────────────────────────────────────────

const esc = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const applyMergeTags = (text, firstName) =>
  text.replace(/\{\{\s*firstName\s*\}\}/gi, () => firstName || "there");

// Plain-text authoring: blank line = paragraph, **bold**, bare https links
// auto-linked. Everything is escaped first, so admin input can never inject
// markup into an email that goes to thousands of inboxes.
export const renderBodyHtml = (body, firstName) =>
  applyMergeTags(body, firstName)
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const html = esc(p)
        .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
        .replace(
          /(https?:\/\/[^\s<]+)/g,
          '<a href="$1" style="color:#0f6e56;">$1</a>',
        )
        .replace(/\n/g, "<br />");
      return `<p style="margin:0 0 16px;">${html}</p>`;
    })
    .join("");

export const makeUnsubscribeUrl = (userId) => {
  const base = (process.env.BACKEND_PUBLIC_URL || "").replace(/\/$/, "");
  if (!base) return null;
  const token = jwt.sign({ uid: String(userId), p: "unsub" }, process.env.JWT_SECRET);
  return `${base}/api/unsubscribe?token=${token}`;
};

export const verifyUnsubscribeToken = (token) => {
  const decoded = jwt.verify(token, process.env.JWT_SECRET);
  if (decoded?.p !== "unsub" || !decoded.uid) throw new Error("Invalid token");
  return decoded.uid;
};

// Builds the final subject + HTML for one recipient.
export const renderCampaignEmail = (campaign, { userId, firstName }) => {
  const critical = campaign.type === "critical";
  const subject = applyMergeTags(campaign.subject, firstName);
  const unsubscribeUrl = critical || !userId ? null : makeUnsubscribeUrl(userId);
  const html = broadcastEmailTemplate({
    subject: esc(subject),
    bodyHtml: renderBodyHtml(campaign.body, firstName),
    ctaLabel: campaign.ctaLabel ? esc(campaign.ctaLabel) : "",
    ctaUrl: campaign.ctaUrl ? esc(campaign.ctaUrl) : "",
    unsubscribeUrl,
    critical,
  });
  return { subject, html, unsubscribeUrl };
};
