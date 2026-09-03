import {
  verifyDojahSignature,
  isDojahIp,
  parseKycWebhookEvent,
} from "../services/dojahService.js";
import { processKycWebhook } from "../services/verificationService.js";

// POST /api/webhooks/dojah
// express.raw({ type: "application/json" }) must be applied BEFORE this
// controller so rawBody is available — JSON.parse is done here, not by
// express.json(), because the HMAC must be computed over the raw bytes.
//
// Security layers (both must pass):
//   1. IP allowlist — Dojah's documented static outbound IP
//   2. HMAC-SHA256 signature — x-dojah-signature header vs raw body
//
// We always respond 200 quickly and do real work after, so Dojah doesn't
// retry on a slow DB write. Mirrors the Paystack webhook convention.
export const handleDojahWebhook = async (req, res) => {
  res.status(200).json({ received: true });

  try {
    if (!isDojahIp(req)) {
      console.warn("[dojah-webhook] Request from unexpected IP:", req.ip);
    }

    const signature = req.headers["x-dojah-signature"];
    if (!verifyDojahSignature(req.body, signature)) {
      console.error("[dojah-webhook] Signature verification failed — ignoring.");
      return;
    }

    let payload;
    try {
      payload = JSON.parse(req.body.toString("utf8"));
    } catch {
      console.error("[dojah-webhook] Could not parse payload as JSON.");
      return;
    }

    const { event, referenceId, dojahStatus, confidence, kycProviderRef } =
      parseKycWebhookEvent(payload);

    if (event !== "verification.complete") return;

    if (!referenceId) {
      console.error("[dojah-webhook] Missing reference_id in payload.");
      return;
    }

    const result = await processKycWebhook({
      referenceId,
      dojahStatus,
      confidence,
      kycProviderRef,
    });

    if (result.skipped) {
      console.info(`[dojah-webhook] Skipped duplicate: ${referenceId}`);
    } else {
      console.info(
        `[dojah-webhook] Processed ${referenceId}: autoApproved=${result.autoApproved}, confidence=${confidence}`,
      );
    }
  } catch (err) {
    console.error("[dojah-webhook] Unhandled error:", err.message);
  }
};
