import {
  submitVerificationRequest,
  listMyVerificationRequests,
  listVerificationRequests,
  resolveVerificationRequest,
  initiateKyc,
} from "../services/verificationService.js";
import { logAudit } from "../utils/auditLogger.js";

// SUBMIT REQUEST — protect-gated (unlike Appeal, which has to work
// without a session); an applicant is by definition not restricted.
export const submitVerificationRequestHandler = async (req, res) => {
  try {
    const { type, entityName, statement } = req.body;
    const request = await submitVerificationRequest({
      userId: req.user._id,
      type,
      entityName,
      statement,
    });
    res.status(201).json({
      message: "Application submitted. Reviews typically take a few business days.",
      request,
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

// MY REQUESTS — the applicant's own queue, so Settings can show live
// status ("pending" / "approved" / "denied") without a moderator round
// trip or a separate notification-only path.
export const listMyVerificationRequestsHandler = async (req, res) => {
  try {
    const requests = await listMyVerificationRequests(req.user._id);
    res.status(200).json({ requests });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// REVIEW QUEUE — reviewer-only (manage_verification), pending-first.
export const listVerificationRequestsHandler = async (req, res) => {
  try {
    const status = req.query.status || "pending";
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(
      Math.max(parseInt(req.query.limit, 10) || 25, 1),
      100,
    );
    const result = await listVerificationRequests({ status, page, limit });
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// RESOLVE REQUEST — approve (grants the badge via the shared write path)
// or deny.
export const resolveVerificationRequestHandler = async (req, res) => {
  try {
    const { decision, note } = req.body;
    const { request, user } = await resolveVerificationRequest({
      requestId: req.params.id,
      reviewerId: req.user._id,
      decision,
      note,
    });

    logAudit({
      action:
        decision === "approved"
          ? "verification_request_approved"
          : "verification_request_denied",
      actor: req.user,
      req,
      target: {
        type: "user",
        ref: request.user,
        snapshot: user
          ? { name: user.name, username: user.username, role: user.role }
          : {},
      },
      detail: {
        requestId: request._id,
        verificationType: request.type,
        note: note || "",
      },
    });

    res.status(200).json({ request, user: user ? { verifications: user.verifications, isVerified: user.isVerified } : undefined });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

// Called just before the Dojah widget launches — records explicit consent
// and increments the KYC attempt counter. Protect-gated (real session).
export const initiateKycHandler = async (req, res) => {
  try {
    const { requestId } = req.body;
    if (!requestId) {
      return res.status(400).json({ message: "requestId is required." });
    }
    const request = await initiateKyc({ requestId, userId: req.user._id });
    res.status(200).json({ request });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};
