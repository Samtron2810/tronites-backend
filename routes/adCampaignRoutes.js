import express from "express";
import protect from "../middleware/authMiddleware.js";
import {
  listCampaigns,
  getCampaign,
  createCampaign,
  updateCampaign,
  initiateCampaignPayment,
  verifyCampaignPayment,
  exportCampaignReport,
  cancelCampaign,
} from "../controllers/adCampaignController.js";

const router = express.Router();

router.get("/", protect, listCampaigns);
router.post("/", protect, createCampaign);
router.get("/:id", protect, getCampaign);
router.put("/:id", protect, updateCampaign);
router.post("/:id/pay", protect, initiateCampaignPayment);
router.get("/:id/verify", protect, verifyCampaignPayment);
router.get("/:id/export", protect, exportCampaignReport);
router.delete("/:id", protect, cancelCampaign);

export default router;
