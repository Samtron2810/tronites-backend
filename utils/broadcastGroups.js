// Recipient groups selectable on the broadcast page. Shared by the zod
// schemas (utils/validators.js) and the audience resolver
// (services/broadcastService.js). Mirrored on the frontend in
// src/constants/broadcast.js.
export const BROADCAST_GROUPS = [
  "all",
  "verified",
  "unverified",
  "individual",
  "creator",
  "business",
  "government",
  "staff",
  "users",
  "moderators",
  "admins",
];

export const BROADCAST_TYPES = ["announcement", "critical"];
