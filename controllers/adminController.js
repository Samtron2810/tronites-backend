import mongoose from "mongoose";
import User from "../models/User.js";
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
    const query = String(req.query.q || "").trim();
    const roleFilter = req.query.role; // "user" | "moderator" | "admin" | undefined
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);
    const skip = (page - 1) * limit;

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

    const [users, totalUsers] = await Promise.all([
      User.find(filter)
        .select(
          "name username email profilePic role createdAt banned suspendedUntil restrictionReason",
        )
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      User.countDocuments(filter),
    ]);

    res.status(200).json({
      users: users.map(toAdminUserDTO),
      currentPage: page,
      totalPages: Math.ceil(totalUsers / limit),
      hasMore: skip + users.length < totalUsers,
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

    const user = await User.findByIdAndUpdate(
      targetId,
      { role },
      { returnDocument: "after", runValidators: true },
    ).select("name username email profilePic role createdAt");

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
  "_id name username email profilePic role createdAt banned suspendedUntil restrictionReason";

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
