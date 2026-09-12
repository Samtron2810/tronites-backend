import express from "express";
import { handlePaystackWebhook } from "../controllers/webhookController.js";

const router = express.Router();

// PAYSTACK WEBHOOK
//
// This route MUST receive the raw (un-parsed) request body so the
// HMAC-SHA512 signature can be verified against the exact bytes Paystack
// signed. express.raw() is applied here at the route level rather than
// globally so the rest of the app can keep using express.json().
//
// IMPORTANT: in app.js, register /api/webhooks BEFORE any global
// express.json() middleware, or configure express.json() to exclude
// this path — once the body has been JSON-parsed the raw Buffer is gone
// and the HMAC check will always fail.
//
// ENV: PAYSTACK_SECRET_KEY — same key used by paystackService.js.
// Paystack dashboard → Settings → API Keys & Webhooks → Webhook URL:
//   https://your-backend.onrender.com/api/webhooks/paystack
router.post(
  "/paystack",
  express.raw({ type: "application/json" }),
  handlePaystackWebhook,
);

export default router;
