import AuditLog from "../models/AuditLog.js";

// PHASE 3 — fire-and-forget audit writer. Moderation endpoints call this
// AFTER the state change has succeeded; a slow or failed audit write must
// never fail (or even delay) the response that already committed the
// action. Nothing here is awaited by callers — every failure surfaces in
// server logs instead of an error path.

// Shallow identity snapshot of the acting account: exactly the fields
// listAuditLogs renders, copied at write time so later renames, demotions
// or deletions can't rewrite history. Deliberately excludes everything
// sensitive (email, restriction fields, token data).
const snapshotActor = (user) =>
  user
    ? {
        _id: user._id,
        name: user.name || "",
        username: user.username || null,
        role: user.role || "",
      }
    : undefined;

/**
 * Record a moderation event.
 *
 * @param {object} p
 * @param {string} p.action       One of AuditLog.AUDIT_ACTIONS.
 * @param {object} p.actor        Usually req.user — snapshotted internally.
 * @param {object} [p.target]     { type, ref, snapshot } — see AuditLog.
 * @param {object} [p.detail]     Action-specific payload (reason, dates…).
 * @param {object} [p.req]        Express request — supplies ip/userAgent.
 * @returns {void}
 */
export const logAudit = ({ action, actor, target, detail = {}, req }) => {
  try {
    new AuditLog({
      action,
      ...(actor ? { actor: snapshotActor(actor) } : {}),
      ...(target ? { target } : {}),
      detail,
      ip: req?.ip || "",
      userAgent: String(req?.headers?.["user-agent"] || "").slice(0, 300),
    })
      .save()
      .catch((err) =>
        console.error(`audit write failed (${action}):`, err.message),
      );
  } catch (err) {
    console.error(`audit enqueue failed (${action}):`, err.message);
  }
};
