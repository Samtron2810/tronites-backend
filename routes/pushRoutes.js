import express from "express";

import protect from "../middleware/authMiddleware.js";
import { validate } from "../utils/validators.js";
import {
  pushSubscribeSchema,
  pushUnsubscribeSchema,
  pushPrefsSchema,
} from "../utils/validators.js";
import {
  getVapidPublicKey,
  subscribe,
  unsubscribe,
  getPushPrefs,
  updatePushPrefs,
} from "../controllers/pushController.js";

const router = express.Router();

router.get("/vapid-key", getVapidPublicKey);
router.post("/subscribe", protect, validate(pushSubscribeSchema), subscribe);
router.delete("/subscribe", protect, validate(pushUnsubscribeSchema), unsubscribe);
router.get("/prefs", protect, getPushPrefs);
router.put("/prefs", protect, validate(pushPrefsSchema), updatePushPrefs);

export default router;
