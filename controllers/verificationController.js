import {
  submitVerificationRequest,
  listMyVerificationRequests,
  listVerificationRequests,
  resolveVerificationRequest,
  checkVerificationEligibility,
  initiateVerificationPayment,
  verifyVerificationPayment,
  getVerificationFeeInfo,
} from "../services/verificationService.js";
import { logAudit } from "../utils/auditLogger.js";

// SUBMIT REQUEST
export const submitVerificationRequestHandler = async (req, res) => {
  try {
    const {
      type,
      entityName,
      legalName,
      dateOfBirth,
      country,
      statement,
      publicLinks,
      paymentId,
    } = req.body;
    const request = await submitVerificationRequest({
      userId: req.user._id,
      type,
      entityName,
      legalName,
      dateOfBirth,
      country,
      statement,
      publicLinks,
      paymentId,
    });
    res.status(201).json({
      message: "Application submitted. Reviews typically take a few business days.",
      request,
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

// MY REQUESTS
export const listMyVerificationRequestsHandler = async (req, res) => {
  try {
    const requests = await listMyVerificationRequests(req.user._id);
    res.status(200).json({ requests });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ELIGIBILITY PRE-CHECK
export const checkEligibilityHandler = async (req, res) => {
  try {
    const { type } = req.query;
    if (!type) return res.status(400).json({ message: "type is required." });
    const result = await checkVerificationEligibility({ userId: req.user._id, type });
    res.status(200).json(result);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message, eligible: false });
  }
};

// FEE INFO — public, no auth needed, so the frontend can show pricing
// on the badge-type picker before the user even starts.
export const getFeeInfoHandler = async (_req, res) => {
  try {
    res.status(200).json(getVerificationFeeInfo());
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// INITIATE PAYMENT — starts a Paystack charge for business badge
export const initiatePaymentHandler = async (req, res) => {
  try {
    const { type } = req.body;
    if (!type) return res.status(400).json({ message: "type is required." });
    const result = await initiateVerificationPayment({
      userId: req.user._id,
      type,
    });
    res.status(200).json(result);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

// VERIFY PAYMENT — called by frontend after Paystack redirect
export const verifyPaymentHandler = async (req, res) => {
  try {
    const { reference } = req.params;
    const result = await verifyVerificationPayment({
      userId: req.user._id,
      reference,
    });
    res.status(200).json(result);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

// REVIEW QUEUE
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

// RESOLVE
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
      user: user
        ? { verifications: user.verifications, isVerified: user.isVerified }
        : undefined,
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};
