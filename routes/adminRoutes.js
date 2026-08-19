import express from "express";

import protect from "../middleware/authMiddleware.js";
import requireAdmin from "../middleware/requireAdmin.js";
import { validate } from "../utils/validators.js";
import { updateRoleSchema } from "../utils/validators.js";
import {
  listUsersForAdmin,
  updateUserRole,
} from "../controllers/adminController.js";

const router = express.Router();

router.get("/users", protect, requireAdmin, listUsersForAdmin);
router.put(
  "/users/:id/role",
  protect,
  requireAdmin,
  validate(updateRoleSchema),
  updateUserRole,
);

export default router;
