import {
  submitAppeal,
  getMyAppealStatus,
  listAppeals,
  resolveAppeal,
} from "../services/appealService.js";
import { logAudit } from "../utils/auditLogger.js";

// SUBMIT APPEAL — no `protect` (see routes/appealRoutes.js); the request
// itself carries the proof of ownership since a restricted account has no
// usable session.
export const submitAppealHandler = async (req, res) => {
  try {
    const { identifier, password, statement } = req.body;
    const appeal = await submitAppeal({ identifier, password, statement });
    res.status(201).json({
      message:
        "Appeal submitted. Your statement would be reviewed in 2-3 business days.",
      appealId: appeal._id,
      status: appeal.status,
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

// CHECK MY APPEAL STATUS — same credential re-proof, read-only.
export const getMyAppealStatusHandler = async (req, res) => {
  try {
    const { identifier, password } = req.body;
    const appeal = await getMyAppealStatus({ identifier, password });
    res.status(200).json({ appeal: appeal || null });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

// MODERATION QUEUE — list appeals (moderator/admin only, see routes).
export const listAppealsHandler = async (req, res) => {
  try {
    const status = req.query.status || "open";
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(
      Math.max(parseInt(req.query.limit, 10) || 25, 1),
      100,
    );

    const result = await listAppeals({ status, page, limit });
    res.status(200).json(result);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

// RESOLVE APPEAL — grant (lifts the restriction) or deny.
export const resolveAppealHandler = async (req, res) => {
  try {
    const { decision, note } = req.body;
    const { appeal, user } = await resolveAppeal({
      appealId: req.params.id,
      moderatorId: req.user._id,
      decision,
      note,
    });

    logAudit({
      action: decision === "granted" ? "appeal_granted" : "appeal_denied",
      actor: req.user,
      req,
      target: {
        type: "user",
        ref: appeal.user,
        snapshot: user
          ? { name: user.name, username: user.username, role: user.role }
          : {},
      },
      detail: {
        appealId: appeal._id,
        restrictionType: appeal.restrictionType,
        note: note || "",
      },
    });

    res.status(200).json({ appeal, user: user || undefined });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};
