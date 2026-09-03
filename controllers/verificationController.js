import {
  submitVerificationRequest,
  listMyVerificationRequests,
  listVerificationRequests,
  resolveVerificationRequest,
  checkVerificationEligibility,
} from "../services/verificationService.js";
import { logAudit } from "../utils/auditLogger.js";

// SUBMIT REQUEST
export const submitVerificationRequestHandler = async (req, res) => {
  try {
    const { type, entityName, legalName, dateOfBirth, country, statement, publicLinks } = req.body;
    const request = await submitVerificationRequest({
      userId: req.user._id,
      type,
      entityName,
      legalName,
      dateOfBirth,
      country,
      statement,
      publicLinks,
    });
    res.status(201).json({
      message: "Application submitted. Reviews typically take a few business days.",
      request,
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

// MY REQUESTS — applicant's own status queue
export const listMyVerificationRequestsHandler = async (req, res) => {
  try {
    const requests = await listMyVerificationRequests(req.user._id);
    res.status(200).json({ requests });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ELIGIBILITY PRE-CHECK — lets the frontend show which requirements fail
// before the user fills out the whole form.
export const checkEligibilityHandler = async (req, res) => {
  try {
    const { type } = req.query;
    if (!type) return res.status(400).json({ message: "type is required." });
    await checkVerificationEligibility({ userId: req.user._id, type });
    res.status(200).json({ eligible: true });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message, eligible: false });
  }
};

// REVIEW QUEUE — reviewer-only (manage_verification), pending-first.
export const listVerificationRequestsHandler = async (req, res) => {
  try {
    const status = req.query.status || "pending";
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 100);
    const result = await listVerificationRequests({ status, page, limit });
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// RESOLVE — approve grants the badge; deny resolves only.
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

    res.status(200).json({
      request,
      user: user ? { verifications: user.verifications, isVerified: user.isVerified } : undefined,
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};
