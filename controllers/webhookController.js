import crypto from "crypto";
import Post from "../models/Post.js";
import VerificationPayment from "../models/VerificationPayment.js";
import { invalidateFeedCache } from "../utils/redis.js";

const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY;
const PROMO_REFERENCE_PREFIX = "tronites_promo_";
const BADGE_REFERENCE_PREFIX = "tronites_vbiz_";
const PROMOTE_POST_DAYS = Number(process.env.PROMOTE_POST_DAYS) || 7;

// POST /api/webhooks/paystack
//
// Paystack sends a signed JSON body for every terminal charge event —
// this is the authoritative source of payment success. The existing
// /posts/promote/verify/:reference and verification flows rely on the
// BROWSER returning from the redirect to call verify, meaning:
//   • user closes the tab after paying → promotion never applied
//   • user loses connectivity mid-redirect → same
//   • Paystack retries (their SLA) but nothing's listening → charge orphaned
//
// This handler is the safety net: it processes charge.success events
// regardless of whether the redirect ever completed, so a successful charge
// always results in the relevant resource being updated.
//
// Security: Paystack signs every webhook body with HMAC-SHA512 using the
// secret key. We verify the signature before doing anything — without this,
// any caller could fake a successful payment.
//
// Body parsing: this route must receive the RAW body (not parsed JSON) for
// the HMAC to verify. Register it with express.raw({ type: 'application/json' })
// in app.js BEFORE the global express.json() middleware.
export const handlePaystackWebhook = async (req, res) => {
  // 1. Verify signature — reject unsigned/tampered bodies immediately.
  const signature = req.headers["x-paystack-signature"];
  if (!signature || !PAYSTACK_SECRET) {
    return res.status(400).json({ message: "Missing signature or secret." });
  }

  const expectedSig = crypto
    .createHmac("sha512", PAYSTACK_SECRET)
    .update(req.body) // req.body is a Buffer when express.raw() is used
    .digest("hex");

  if (
    !crypto.timingSafeEqual(
      Buffer.from(signature, "hex"),
      Buffer.from(expectedSig, "hex"),
    )
  ) {
    return res.status(401).json({ message: "Invalid signature." });
  }

  // 2. Parse the verified body.
  let event;
  try {
    event = JSON.parse(req.body.toString("utf8"));
  } catch {
    return res.status(400).json({ message: "Invalid JSON body." });
  }

  // 3. Acknowledge immediately — Paystack retries on non-2xx. The actual
  // work is done after the response so a slow DB write never causes a retry.
  res.status(200).json({ received: true });

  // 4. Handle events asynchronously (fire-and-forget from Paystack's perspective).
  try {
    if (event.event !== "charge.success") return; // only care about successful charges

    const { reference, status } = event.data || {};
    if (status !== "success" || !reference) return;

    if (reference.startsWith(PROMO_REFERENCE_PREFIX)) {
      await handlePromoWebhook(reference);
    } else if (reference.startsWith(BADGE_REFERENCE_PREFIX)) {
      await handleBadgeWebhook(reference);
    }
    // Unknown reference prefix — a payment from a different flow or environment.
    // Silently ignore; already acknowledged with 200 above.
  } catch (err) {
    // Never let a processing error bubble up to Paystack (response already sent).
    console.error("[PaystackWebhook] processing error:", err.message);
  }
};

// Apply a successful promotion charge to the matching post.
// Idempotent: if promotedUntil is already set and in the future
// (browser redirect already processed it), skip — don't extend.
const handlePromoWebhook = async (reference) => {
  const post = await Post.findOne({ promotionReference: reference }).select(
    "promotedUntil promotionReference",
  );
  if (!post) {
    console.warn("[PaystackWebhook] promo post not found for ref:", reference);
    return;
  }

  // Already applied (browser redirect got here first) — idempotent skip.
  if (post.promotedUntil && new Date(post.promotedUntil) > new Date()) {
    return;
  }

  const promotedUntil = new Date(
    Date.now() + PROMOTE_POST_DAYS * 24 * 60 * 60 * 1000,
  );
  await post.updateOne({
    $set: { promotedUntil, promotionReference: null },
  });

  // Invalidate feed cache for the post owner so the Sponsored badge
  // appears immediately without waiting for cache TTL.
  invalidateFeedCache(post.user).catch(() => {});

  console.log(
    `[PaystackWebhook] promotion applied: post=${post._id} until=${promotedUntil.toISOString()}`,
  );
};

// Mark a badge VerificationPayment as verified so the browser-redirect
// /verify flow can be a no-op when it arrives (idempotent).
const handleBadgeWebhook = async (reference) => {
  const result = await VerificationPayment.updateOne(
    { reference, status: { $ne: "verified" } }, // idempotent
    { $set: { status: "verified", paystackStatus: "success" } },
  );
  if (result.matchedCount === 0) {
    // Either already verified (fine) or reference not found (unknown charge).
    console.warn("[PaystackWebhook] badge payment not found or already verified:", reference);
  } else {
    console.log("[PaystackWebhook] badge payment verified:", reference);
  }
};
