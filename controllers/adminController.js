import mongoose from "mongoose";
import User, { DEFAULT_MODERATOR_PERMISSIONS, VERIFICATION_TYPES } from "../models/User.js";
import Notification from "../models/Notification.js";
import AuditLog, { AUDIT_ACTIONS } from "../models/AuditLog.js";
import { toAdminUserDTO } from "../dtos/userDTO.js";
import { emitToUser, disconnectUser } from "../socket/socket.js";
import { revokeAllSessions } from "../utils/tokens.js";
import { invalidateCache, invalidateFeedCache } from "../utils/redis.js";
import { logAudit } from "../utils/auditLogger.js";

// LIST/SEARCH USERS (admin only) — paginated, optional name/username/
// email search and role filter, for the admin panel's user picker.
export const listUsersForAdmin = async (req, res) => {
  try {
    // Phase 6 -- sortBy=reportCount and/or minReportCount=N switch to an
    // aggregation that joins per-owner report totals (Report's
    // {targetOwner:1} index keeps the lookup cheap) so the panel can
    // surface "most reported" accounts. Plain requests keep the fast
    // find() path -- whose select now also carries strikes/permissions
    // so strike badges and the permission editor reflect reality.
    const query = String(req.query.q || "").trim();
    const roleFilter = req.query.role; // "user" | "moderator" | "admin" | undefined
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);
    const skip = (page - 1) * limit;

    const sortByReportCount = req.query.sortBy === "reportCount";
    const minReportCount = parseInt(req.query.minReportCount, 10) || 0;
    const needsReportsJoin = sortByReportCount || minReportCount > 0;

    const filter = {};
    if (query.length >= 2) {
      filter.$or = [
        { name: { $regex: query, $options: "i" } },
        { username: { $regex: query, $options: "i" } },
        { email: { $regex: query, $options: "i" } },
      ];
    }
    if (["user", "moderator", "admin"].includes(roleFilter)) {
      filter.role = roleFilter;
    }

    if (!needsReportsJoin) {
      const [users, totalUsers] = await Promise.all([
        User.find(filter)
          .select(
            "_id name username email profilePic role createdAt banned suspendedUntil restrictionReason strikes permissions verifications isVerified",
          )
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit)
          .lean(),
        User.countDocuments(filter),
      ]);

      return res.status(200).json({
        users: users.map(toAdminUserDTO),
        currentPage: page,
        totalPages: Math.ceil(totalUsers / limit),
        hasMore: skip + users.length < totalUsers,
      });
    }

    // Aggregation path -- $lookup attaches every candidate's report
    // total; minReportCount filters AFTER the join so pages are filled
    // with qualifying accounts instead of trimmed to nothing. $facet
    // gets filtered total + page in one round trip.
    const reportCountFilter =
      minReportCount > 0
        ? [{ $match: { reportCount: { $gte: minReportCount } } }]
        : [];
    const sortStage = sortByReportCount
      ? { reportCount: -1, createdAt: -1 }
      : { createdAt: -1 };

    const [agg] = await User.aggregate([
      { $match: filter },
      {
        $lookup: {
          from: "reports",
          localField: "_id",
          foreignField: "targetOwner",
          as: "_reports",
        },
      },
      { $addFields: { reportCount: { $size: "$_reports" } } },
      { $project: { _reports: 0 } },
      {
        $facet: {
          data: [
            ...reportCountFilter,
            { $sort: sortStage },
            { $skip: skip },
            { $limit: limit },
          ],
          total: [...reportCountFilter, { $count: "value" }],
        },
      },
    ]);

    const docs = agg?.data ?? [];
    const totalUsers = agg?.total?.[0]?.value ?? 0;

    res.status(200).json({
      users: docs.map(toAdminUserDTO),
      currentPage: page,
      totalPages: Math.ceil(totalUsers / limit),
      hasMore: skip + docs.length < totalUsers,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// UPDATE A USER'S ROLE (admin only)
export const updateUserRole = async (req, res) => {
  try {
    const { role } = req.body;
    const targetId = req.params.id;

    // Prevent an admin from demoting themselves out of the only admin
    // account — a self-lockout with no remaining way to grant admin
    // back (per the model comment: role is otherwise only set directly
    // in the database).
    if (targetId === req.user._id.toString() && role !== "admin") {
      const otherAdmins = await User.countDocuments({
        role: "admin",
        _id: { $ne: req.user._id },
      });
      if (otherAdmins === 0) {
        return res.status(400).json({
          message: "You're the only admin — promote another admin before changing your own role.",
        });
      }
    }

    // Phase 5 -- keep permissions coherent across role transitions:
    // promoting to moderator seeds the default set ONLY when no explicit
    // array exists yet (re-granting must not clobber an admin-curated
    // set); demoting to a plain user clears it entirely. Admin targets
    // keep whatever is stored -- their gate short-circuits anyway.
    const preUpdate = await User.findById(targetId).select("permissions");
    if (!preUpdate) {
      return res.status(404).json({ message: "User not found." });
    }

    const updateOps = { role };
    if (
      role === "moderator" &&
      !(preUpdate.permissions && preUpdate.permissions.length)
    ) {
      updateOps.$set = { permissions: [...DEFAULT_MODERATOR_PERMISSIONS] };
    }
    if (role === "user") {
      updateOps.$set = { permissions: [] };
    }

    const user = await User.findByIdAndUpdate(targetId, updateOps, {
      returnDocument: "after",
      runValidators: true,
    }).select("name username email profilePic role createdAt permissions");

    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    // Phase 3 — role changes are exactly what an audit trail exists for.
    logAudit({
      action: "user_role_changed",
      actor: req.user,
      req,
      target: {
        type: "user",
        ref: user._id,
        snapshot: { name: user.name, username: user.username, role: user.role },
      },
      detail: { toRole: role },
    });

    res.status(200).json({ user: toAdminUserDTO(user) });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ─── Account restrictions (Phase 2) ─────────────────────────────────────────
//
// suspend / ban / unrestrict. The restriction itself is just three fields
// on User — the real work is the enforcement web around it:
//   authMiddleware     → rejects every API call mid-session
//   loginUser          → rejects new logins with the same codes
//   refreshAccessToken → stops refresh-token rotation for dead accounts
//   revokeAllSessions  → deletes live refresh tokens immediately
//   disconnectUser     → force-drops open sockets (after a warning emit)
// Expired suspensions self-heal: every check compares against now(), so
// access simply resumes with no cleanup job.

const RESTRICTION_TARGET_SELECT =
  "_id name username email profilePic role createdAt banned suspendedUntil restrictionReason verifications isVerified";

// Phase 4 -- crossing this many strikes makes the FRONTEND suggest a
// suspension; the backend never auto-suspends (human in the loop).
const STRIKE_THRESHOLD = 3;

// Shared target guards. Returns an error message string, or null if the
// action may proceed.
const restrictionGuardError = (requester, target) => {
  // Nobody restricts themselves — a moderator locking their own account
  // out mid-action has no undo path except another admin's intervention.
  if (target._id.toString() === requester._id.toString()) {
    return "You can't restrict your own account.";
  }
  // Admins are never restrictable via the API — same self-lockout
  // philosophy as updateUserRole's last-admin guard: privilege disputes
  // between admins are resolved out-of-band, not through these endpoints.
  if (target.role === "admin") {
    return "Admin accounts can't be restricted.";
  }
  // Moderators work bottom-rung only; restricting fellow moderators is an
  // escalation decision reserved for admins (who use these same routes).
  if (requester.role !== "admin" && target.role === "moderator") {
    return "Moderators can't restrict other moderators.";
  }
  return null;
};

// Best-effort enforcement fan-out after a successful DB update. Never
// blocks or fails the response — each piece mirrors existing
// fire-and-forget patterns used elsewhere in the codebase.
const applyRestrictionSideEffects = (userId, payload) => {
  try {
    // Warn first; disconnectUser's built-in delay gives this frame time
    // to flush before the socket dies.
    emitToUser(userId, "accountRestricted", payload);
  } catch (socketError) {
    console.error("accountRestricted emit failed:", socketError.message);
  }
  disconnectUser(userId);
  revokeAllSessions(userId).catch((err) =>
    console.error("revokeAllSessions failed:", err.message),
  );
  invalidateFeedCache(userId);
  invalidateCache(`profile-posts:${userId}:*`);
};

// PUT /admin/users/:id/suspend — requireModerator (mods included).
export const suspendUser = async (req, res) => {
  try {
    const target = await User.findById(req.params.id).select(
      RESTRICTION_TARGET_SELECT,
    );
    if (!target) {
      return res.status(404).json({ message: "User not found." });
    }

    const guardError = restrictionGuardError(req.user, target);
    if (guardError) {
      return res.status(403).json({ message: guardError });
    }
    if (target.banned) {
      return res
        .status(400)
        .json({ message: "This account is permanently banned already." });
    }

    const until = req.body.until;
    if (!(until instanceof Date) || !(until > new Date())) {
      return res
        .status(400)
        .json({ message: "Suspension end must be a date in the future." });
    }

    const updated = await User.findByIdAndUpdate(
      req.params.id,
      {
        $set: {
          suspendedUntil: until,
          restrictionReason: req.body.reason || "",
        },
      },
      { returnDocument: "after", runValidators: true },
    ).select(RESTRICTION_TARGET_SELECT);

    applyRestrictionSideEffects(target._id, {
      code: "ACCOUNT_SUSPENDED",
      reason: req.body.reason || "",
      suspendedUntil: until,
      message: `Your account is suspended until ${until.toLocaleString()}.`,
    });

    logAudit({
      action: "user_suspended",
      actor: req.user,
      req,
      target: {
        type: "user",
        ref: target._id,
        snapshot: { name: target.name, username: target.username, role: target.role },
      },
      detail: { reason: req.body.reason || "", suspendedUntil: until },
    });

    res.status(200).json({ user: toAdminUserDTO(updated) });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// PUT /admin/users/:id/ban — requireAdmin only (higher stakes, and
// structurally unavailable to moderators regardless of client UI).
export const banUser = async (req, res) => {
  try {
    const target = await User.findById(req.params.id).select(
      RESTRICTION_TARGET_SELECT,
    );
    if (!target) {
      return res.status(404).json({ message: "User not found." });
    }

    const guardError = restrictionGuardError(req.user, target);
    if (guardError) {
      return res.status(403).json({ message: guardError });
    }
    if (target.banned) {
      return res
        .status(400)
        .json({ message: "This account is already permanently banned." });
    }

    const updated = await User.findByIdAndUpdate(
      req.params.id,
      {
        // A ban supersedes any active suspension — leaving a stale
        // suspendedUntil would make "unrestrict" ambiguous about which
        // restriction was being lifted.
        $set: {
          banned: true,
          suspendedUntil: null,
          restrictionReason: req.body.reason || "",
        },
      },
      { returnDocument: "after", runValidators: true },
    ).select(RESTRICTION_TARGET_SELECT);

    applyRestrictionSideEffects(target._id, {
      code: "ACCOUNT_BANNED",
      reason: req.body.reason || "",
      suspendedUntil: null,
      message: "Your account has been banned.",
    });

    logAudit({
      action: "user_banned",
      actor: req.user,
      req,
      target: {
        type: "user",
        ref: target._id,
        snapshot: { name: target.name, username: target.username, role: target.role },
      },
      detail: { reason: req.body.reason || "" },
    });

    res.status(200).json({ user: toAdminUserDTO(updated) });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// PUT /admin/users/:id/unrestrict — requireModerator. Clears all three
// fields in one shot; idempotent by construction (clearing an already-
// clear account is a no-op write). No session/socket killing here —
// restoring access means letting the user sign back in normally.
export const unrestrictUser = async (req, res) => {
  try {
    const target = await User.findById(req.params.id).select(
      RESTRICTION_TARGET_SELECT,
    );
    if (!target) {
      return res.status(404).json({ message: "User not found." });
    }

    const guardError = restrictionGuardError(req.user, target);
    if (guardError) {
      return res.status(403).json({ message: guardError });
    }

    const updated = await User.findByIdAndUpdate(
      req.params.id,
      {
        $set: { banned: false, suspendedUntil: null, restrictionReason: "" },
      },
      { returnDocument: "after", runValidators: true },
    ).select(RESTRICTION_TARGET_SELECT);

    // Record WHAT was lifted — reviewing reversals later needs to know
    // whether it was an early suspension end, an unban, or both.
    logAudit({
      action: "user_unrestricted",
      actor: req.user,
      req,
      target: {
        type: "user",
        ref: target._id,
        snapshot: { name: target.name, username: target.username, role: target.role },
      },
      detail: {
        clearedBan: !!target.banned,
        clearedSuspensionUntil: target.suspendedUntil || null,
      },
    });

    res.status(200).json({ user: toAdminUserDTO(updated) });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// --- Audit log (Phase 3) -----------------------------------------------------

// GET /admin/audit � requireAdmin. Paginated, filterable read over the
// append-only AuditLog collection. Query params:
//   limit=50 (1�100)  offset=0  sort=-createdAt|createdAt
//   action=user_suspended,user_banned   (CSV; unknown values ignored)
//   targetType=user|post|comment|message|report
//   actor=<userId>
export const listAuditLogs = async (req, res) => {
  try {
    const limit = Math.min(
      Math.max(parseInt(req.query.limit, 10) || 50, 1),
      100,
    );
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const filter = {};

    if (req.query.action) {
      const actions = String(req.query.action)
        .split(",")
        .map((a) => a.trim())
        .filter((a) => AUDIT_ACTIONS.includes(a));
      if (actions.length) filter.action = { $in: actions };
    }

    if (
      ["user", "post", "comment", "message", "report"].includes(
        req.query.targetType,
      )
    ) {
      filter["target.type"] = req.query.targetType;
    }

    if (req.query.actor && mongoose.isValidObjectId(req.query.actor)) {
      filter["actor._id"] = new mongoose.Types.ObjectId(req.query.actor);
    }

    const sortDirection = req.query.sort === "createdAt" ? 1 : -1;

    const [logs, total] = await Promise.all([
      AuditLog.find(filter)
        .sort({ createdAt: sortDirection })
        .skip(offset)
        .limit(limit)
        .lean(),
      AuditLog.countDocuments(filter),
    ]);

    res.status(200).json({
      logs,
      total,
      limit,
      offset,
      hasMore: offset + logs.length < total,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Phase 4 -- formal warnings/strikes. POST /admin/users/:id/warn --
// requireModerator. Appends a strike, notifies the user in-app (reason
// included; neither the reporter NOR the issuing moderator is identified
// in what the user sees), writes user_warned to the Phase 3 audit trail,
// and reports whether STRIKE_THRESHOLD was crossed so the UI can prompt
// the moderator to consider a suspension. Deliberately NO auto-suspend:
// a human decides what repeated warnings mean.
export const warnUser = async (req, res) => {
  try {
    const target = await User.findById(req.params.id).select(
      "_id name username role strikes banned deletedAt"
    );
    if (!target) {
      return res.status(404).json({ message: "User not found." });
    }

    // Same rulebook as suspend/ban/unrestrict: nobody warns themselves,
    // admins are never warnable, moderators can't warn other moderators.
    // Warning-specific states on top: already-banned and pending-deletion
    // accounts can't meaningfully receive warnings.
    if (target._id.toString() === req.user._id.toString()) {
      return res.status(403).json({ message: "You can't warn your own account." });
    }
    if (target.role === "admin") {
      return res.status(403).json({ message: "Admin accounts can't be warned." });
    }
    if (req.user.role !== "admin" && target.role === "moderator") {
      return res.status(403).json({ message: "Moderators can't warn other moderators." });
    }
    if (target.banned) {
      return res.status(400).json({ message: "This account is already permanently banned." });
    }
    if (target.deletedAt) {
      return res.status(400).json({ message: "This account is pending deletion." });
    }

    const reportId =
      req.body.reportId && mongoose.isValidObjectId(req.body.reportId)
        ? new mongoose.Types.ObjectId(req.body.reportId)
        : null;

    const updated = await User.findByIdAndUpdate(
      req.params.id,
      {
        $push: {
          strikes: {
            reason: req.body.reason,
            moderator: req.user._id,
            ...(reportId ? { reportId } : {}),
            createdAt: new Date(),
          },
        },
      },
      { returnDocument: "after", runValidators: true }
    ).select(RESTRICTION_TARGET_SELECT + " strikes");

    const strikeCount = updated.strikes.length;
    const strikeThresholdReached = strikeCount >= STRIKE_THRESHOLD;

    logAudit({
      action: "user_warned",
      actor: req.user,
      req,
      target: {
        type: "user",
        ref: target._id,
        snapshot: { name: target.name, username: target.username, role: target.role },
      },
      detail: { reason: req.body.reason, reportId: reportId || null, strikeCount },
    });

    // In-app notification, best effort. sender stays set (the schema
    // requires it) but the notifications page never renders it for
    // moderator_warning -- the user sees "Moderation team" plus the
    // reason, nothing more.
    try {
      const newNotif = await Notification.create({
        recipient: target._id,
        sender: req.user._id,
        type: "moderator_warning",
        message: req.body.reason,
      });
      const populatedNotif = await newNotif.populate(
        "sender",
        "name username profilePic verifications isVerified"
      );
      emitToUser(target._id, "newNotification", populatedNotif);
    } catch (notifError) {
      console.error("Warning notification failed:", notifError.message);
    }

    res.status(200).json({
      strikeCount,
      strikeThresholdReached,
      user: toAdminUserDTO(updated),
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ─── Granular permissions (Phase 5) ──────────────────────────────────────────

// PUT /admin/users/:id/permissions -- requireAdmin. Whole-array
// replacement of a MODERATOR's explicit permission set (see
// middleware/requirePermission.js for resolution semantics: non-empty
// array is authoritative; empty falls back to defaults). Admins are
// rejected -- their access is implicit and cannot be tuned; plain users
// are rejected too -- grant capabilities by promoting first, never by
// handing permissions to an account every route already rejects.
export const updateUserPermissions = async (req, res) => {
  try {
    const target = await User.findById(req.params.id).select(
      "_id name username email profilePic role permissions createdAt"
    );
    if (!target) {
      return res.status(404).json({ message: "User not found." });
    }
    if (target.role !== "moderator") {
      return res.status(400).json({
        message:
          target.role === "admin"
            ? "Admins hold every permission implicitly."
            : "Permissions apply to moderators -- promote this account first.",
      });
    }

    const previousPermissions = Array.isArray(target.permissions)
      ? target.permissions
      : [];

    const updated = await User.findByIdAndUpdate(
      req.params.id,
      { $set: { permissions: req.body.permissions } },
      { returnDocument: "after", runValidators: true },
    ).select("name username email profilePic role createdAt permissions banned suspendedUntil restrictionReason strikes");

    logAudit({
      action: "user_permissions_changed",
      actor: req.user,
      req,
      target: {
        type: "user",
        ref: target._id,
        snapshot: {
          name: target.name,
          username: target.username,
          role: target.role,
        },
      },
      detail: {
        permissions: req.body.permissions,
        previousPermissions,
      },
    });

    res.status(200).json({ user: toAdminUserDTO(updated) });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// POST /admin/users/bulk -- requireAdmin. Applies one restriction action
// across up to 100 accounts, mirroring the exact guard/update/side-effect/
// audit sequence of the single-user endpoints. Partial-success semantics:
// each id gets its own result row and HTTP stays 200 even when some fail
// (self/admin targets, already-banned accounts), while every successful
// write logs its own audit entry -- the trail answers "who restricted
// THIS account" per user, never as one batched blob. Deliberately omits
// the plan doc's bulk "role" action: mass role changes are a privilege-
// escalation foot-gun with no consumer.
export const bulkUpdateUsers = async (req, res) => {
  const { userIds, action, until, reason } = req.body;

  // Dedupe preserving order; invalid ObjectIds are dropped here so one
  // garbage id cannot poison the batch (zod already capped size).
  const seen = new Set();
  const ids = [];
  for (const raw of userIds) {
    if (!mongoose.isValidObjectId(raw)) continue;
    const key = new mongoose.Types.ObjectId(raw).toString();
    if (!seen.has(key)) {
      seen.add(key);
      ids.push(key);
    }
  }
  if (!ids.length) {
    return res.status(400).json({ message: "No valid user ids supplied." });
  }

  const results = [];
  let succeeded = 0;

  for (const id of ids) {
    try {
      const target = await User.findById(id).select(
        "_id name username role banned suspendedUntil deletedAt"
      );
      if (!target) {
        results.push({ userId: id, ok: false, error: "User not found." });
        continue;
      }

      const guardError = restrictionGuardError(req.user, target);
      if (guardError) {
        results.push({ userId: id, ok: false, error: guardError });
        continue;
      }
      // Parity with banUser's early-out; suspend/unrestrict stay
      // idempotent by design, exactly like their single-user versions.
      if (action === "ban" && target.banned) {
        results.push({
          userId: id,
          ok: false,
          error: "Already permanently banned.",
        });
        continue;
      }

      let setOps;
      let sideEffects = null;
      let auditAction;
      if (action === "suspend") {
        setOps = { suspendedUntil: until, restrictionReason: reason || "" };
        sideEffects = {
          code: "ACCOUNT_SUSPENDED",
          reason: reason || "",
          suspendedUntil: until,
          message: `Your account is suspended until ${until.toLocaleString()}.`,
        };
        auditAction = "user_suspended";
      } else if (action === "ban") {
        setOps = {
          banned: true,
          suspendedUntil: null,
          restrictionReason: reason || "",
        };
        sideEffects = {
          code: "ACCOUNT_BANNED",
          reason: reason || "",
          suspendedUntil: null,
          message: "Your account has been banned.",
        };
        auditAction = "user_banned";
      } else {
        setOps = { banned: false, suspendedUntil: null, restrictionReason: "" };
        auditAction = "user_unrestricted";
      }

      const updated = await User.findByIdAndUpdate(
        id,
        { $set: setOps },
        { returnDocument: "after", runValidators: true },
      ).select(RESTRICTION_TARGET_SELECT);

      if (sideEffects) applyRestrictionSideEffects(target._id, sideEffects);

      logAudit({
        action: auditAction,
        actor: req.user,
        req,
        target: {
          type: "user",
          ref: target._id,
          snapshot: {
            name: target.name,
            username: target.username,
            role: target.role,
          },
        },
        detail:
          action === "suspend"
            ? { reason: reason || "", suspendedUntil: until, bulk: true }
            : action === "ban"
              ? { reason: reason || "", bulk: true }
              : {
                  clearedBan: !!target.banned,
                  clearedSuspensionUntil: target.suspendedUntil || null,
                  bulk: true,
                },
      });

      succeeded += 1;
      results.push({ userId: id, ok: true });
    } catch (e) {
      results.push({ userId: id, ok: false, error: e.message });
    }
  }

  res.status(200).json({
    results,
    succeeded,
    failed: results.length - succeeded,
  });
};

// ─── Verification badges (Phase 1 — manual grant/revoke only) ─────────────
//
// CLAIM model, not status: each badge asserts one specific, falsifiable
// thing. "staff" is never independently grantable through this endpoint —
// it derives from `role` in one direction only (role → badge). Everything
// else requires manage_verification, kept separate from manage_users so
// "can suspend accounts" and "can attest identity" stay different blast
// radii (see PERMISSIONS comment in models/User.js).

// POST /admin/users/:id/verification -- requirePermission("manage_verification").
// Grants one badge type. Idempotent per-type: re-granting an existing,
// non-expired badge just refreshes verifiedAt/entityName/expiresAt rather
// than duplicating the subdocument.
export const grantVerification = async (req, res) => {
  try {
    const { type, entityName, expiresAt } = req.body;

    if (type === "staff") {
      return res.status(400).json({
        message:
          "Staff badges derive from role and can't be granted directly — promote to moderator/admin instead.",
      });
    }

    if (["business", "government"].includes(type) && !entityName) {
      return res.status(400).json({
        message: `entityName is required for a ${type} badge — that's the whole point of the claim.`,
      });
    }

    if (expiresAt && new Date(expiresAt) <= new Date()) {
      return res.status(400).json({ message: "expiresAt must be in the future." });
    }

    const target = await User.findById(req.params.id).select(
      "_id name username email profilePic role verifications isVerified createdAt banned suspendedUntil restrictionReason strikes permissions",
    );
    if (!target) {
      return res.status(404).json({ message: "User not found." });
    }

    const existingIndex = (target.verifications || []).findIndex(
      (v) => v.type === type,
    );

    const entry = {
      type,
      verifiedAt: new Date(),
      expiresAt: expiresAt || null,
      method: "manual",
      providerRef: "",
      entityName: entityName || "",
      reviewedBy: req.user._id,
    };

    if (existingIndex >= 0) {
      target.verifications[existingIndex] = entry;
    } else {
      target.verifications.push(entry);
    }
    target.isVerified = true;

    await target.save();

    logAudit({
      action: "user_verification_granted",
      actor: req.user,
      req,
      target: {
        type: "user",
        ref: target._id,
        snapshot: {
          name: target.name,
          username: target.username,
          role: target.role,
        },
      },
      detail: { verificationType: type, entityName: entityName || "", expiresAt: expiresAt || null },
    });

    res.status(200).json({ user: toAdminUserDTO(target) });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// DELETE /admin/users/:id/verification/:type -- requirePermission("manage_verification").
// Drops one badge type. Staff badges can be revoked here (e.g. offboarding
// edge case) even though they can't be *granted* here — the asymmetry is
// intentional: taking a badge away is always safe, handing one out bypassing
// the role-derivation rule is not.
export const revokeVerification = async (req, res) => {
  try {
    const { type } = req.params;
    const { reason } = req.body;

    if (!VERIFICATION_TYPES.includes(type)) {
      return res.status(400).json({ message: "Invalid verification type." });
    }

    const target = await User.findById(req.params.id).select(
      "_id name username email profilePic role verifications isVerified createdAt banned suspendedUntil restrictionReason strikes permissions",
    );
    if (!target) {
      return res.status(404).json({ message: "User not found." });
    }

    const before = target.verifications.length;
    target.verifications = target.verifications.filter((v) => v.type !== type);
    if (target.verifications.length === before) {
      return res.status(400).json({ message: `User doesn't hold a ${type} badge.` });
    }
    target.isVerified = target.verifications.length > 0;

    await target.save();

    logAudit({
      action: "user_verification_revoked",
      actor: req.user,
      req,
      target: {
        type: "user",
        ref: target._id,
        snapshot: {
          name: target.name,
          username: target.username,
          role: target.role,
        },
      },
      detail: { verificationType: type, reason: reason || "" },
    });

    res.status(200).json({ user: toAdminUserDTO(target) });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
