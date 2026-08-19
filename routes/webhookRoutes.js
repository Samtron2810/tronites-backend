import express from "express";
import { handleCloudinaryWebhook } from "../controllers/webhookController.js";

const router = express.Router();

// express.raw() here (not the app-wide express.json()) — signature
// verification needs the exact bytes Cloudinary sent, see
// webhookController.js for why re-parsed-then-restringified JSON
// doesn't work for this.
router.post(
  "/cloudinary",
  express.raw({ type: "application/json" }),
  handleCloudinaryWebhook,
);

export default router;
