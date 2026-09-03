import crypto from "crypto";

// DOJAH SERVICE (Phase 3)
// Handles webhook signature verification and payload normalisation.
// This file is the ONLY place in the codebase that ever sees raw Dojah
// webhook data — it extracts only the opaque reference ID, status, and
// confidence score and discards everything else (NIN number, BVN, selfie
// URL, document scan URLs). Never log the raw payload in production.
//
// To add Didit later: create services/diditService.js with the same
// exported interface (verifyWebhookSignature, parseKycWebhookEvent) and
// mount a second route in webhookRoutes.js. No changes needed here.

const DOJAH_WEBHOOK_SECRET = process.env.DOJAH_WEBHOOK_SECRET;
const DOJAH_ALLOWED_IP = "135.119.89.106"; // Dojah's documented static IP

// Verifies x-dojah-signature against the raw request body bytes.
// Must be called with the raw Buffer body (express.raw() middleware),
// not the parsed JSON — HMAC is over the exact bytes Dojah sent.
export const verifyDojahSignature = (rawBody, signatureHeader) => {
  if (!DOJAH_WEBHOOK_SECRET) {
    throw new Error("DOJAH_WEBHOOK_SECRET env var is not set.");
  }
  if (!signatureHeader) return false;

  const expected = crypto
    .createHmac("sha256", DOJAH_WEBHOOK_SECRET)
    .update(rawBody)
    .digest("hex");

  // Constant-time comparison to prevent timing attacks.
  try {
    return crypto.timingSafeEqual(
      Buffer.from(signatureHeader, "hex"),
      Buffer.from(expected, "hex"),
    );
  } catch {
    return false;
  }
};

// Validates the request IP against Dojah's documented static outbound IP.
// This is a defence-in-depth measure alongside the HMAC signature —
// either check alone is spoofable in isolation, together they raise the
// bar significantly.
export const isDojahIp = (req) => {
  const ip =
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.socket?.remoteAddress;
  return ip === DOJAH_ALLOWED_IP;
};

// Normalises the Dojah KYC Widget webhook payload into the shape
// processKycWebhook expects. Extracts ONLY what the service layer needs:
// the reference ID (our VerificationRequest._id), overall status, face-
// match confidence, and Dojah's own reference. Everything else (NIN
// number, date of birth, address, selfie URL) is intentionally discarded
// here — we never persist raw identity data.
//
// Dojah webhook shape (KYC Widget, "verification.complete" event):
// {
//   event: "verification.complete",
//   data: {
//     reference_id: "<our VerificationRequest._id>",
//     status: true | false,
//     verification: {
//       nin: { confidence: 85, ... },  // or bvn
//       face: { confidence: 91, ... },
//     },
//     app_id: "...",
//     index_id: "...",   // Dojah's own reference
//   }
// }
export const parseKycWebhookEvent = (payload) => {
  const data = payload?.data ?? {};

  const referenceId = data.reference_id ?? "";
  const dojahStatus = data.status === true;
  const kycProviderRef = data.index_id ?? data.app_id ?? "";

  // Confidence: take the face-match score when available (most reliable
  // for individual identity), fall back to NIN/BVN lookup confidence.
  // Dojah returns 0–100 integers.
  const faceConfidence = data.verification?.face?.confidence ?? null;
  const ninConfidence = data.verification?.nin?.confidence ?? null;
  const bvnConfidence = data.verification?.bvn?.confidence ?? null;
  const confidence =
    faceConfidence ?? ninConfidence ?? bvnConfidence ?? 0;

  return {
    referenceId,
    dojahStatus,
    confidence: Number(confidence),
    kycProviderRef,
    // event type for the webhook controller to gate on
    event: payload?.event ?? "",
  };
};
