import express from "express";
import { unsubscribe } from "../controllers/broadcastController.js";

const router = express.Router();
router.get("/", unsubscribe);
// RFC 8058 one-click unsubscribe (mail providers POST here with no cookies
// and no Origin header — mounted ahead of csrfProtection in index.js).
router.post("/", unsubscribe);

export default router;
