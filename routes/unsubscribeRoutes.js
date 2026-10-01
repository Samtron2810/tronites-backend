import express from "express";
import { unsubscribe } from "../controllers/broadcastController.js";

const router = express.Router();
router.get("/", unsubscribe);

export default router;
