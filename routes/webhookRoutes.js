import express from "express";
import { handleDojahWebhook } from "../controllers/webhookController.js";

const router = express.Router();

// express.raw() before express.json() — HMAC must be over raw bytes.
router.post(
  "/dojah",
  express.raw({ type: "application/json", limit: "1mb" }),
  handleDojahWebhook,
);

export default router;
