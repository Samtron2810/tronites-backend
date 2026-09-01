import PushSubscription from "../models/PushSubscription.js";
import User from "../models/User.js";
import { isPushEnabled } from "../services/pushService.js";
import asyncHandler from "../middleware/asyncHandler.js";

// GET /api/push/vapid-key — public key the frontend needs to call
// pushManager.subscribe(). Not secret by design (that's the point of the
// public/private VAPID split), so no auth required — lets the install
// prompt flow fetch it before the user is necessarily logged in on a
// fresh device, though in practice subscribe itself is behind `protect`.
export const getVapidPublicKey = asyncHandler(async (req, res) => {
  if (!isPushEnabled()) {
    return res.status(503).json({ message: "Push notifications are not configured on this server." });
  }
  res.status(200).json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

// POST /api/push/subscribe — upsert by endpoint so re-subscribing (e.g.
// browser rotated the endpoint, or the same user re-enables push after
// having denied it) never creates a duplicate row for the same device.
export const subscribe = asyncHandler(async (req, res) => {
  const { endpoint, keys } = req.body;

  await PushSubscription.findOneAndUpdate(
    { endpoint },
    {
      user: req.user._id,
      endpoint,
      keys,
      userAgent: req.headers["user-agent"] || "",
      lastSeenAt: new Date(),
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  res.status(200).json({ subscribed: true });
});

// DELETE /api/push/subscribe — called on explicit opt-out (toggle off in
// Settings) or when the frontend detects pushManager.getSubscription()
// returned null but a stale endpoint is still known locally.
export const unsubscribe = asyncHandler(async (req, res) => {
  const { endpoint } = req.body;
  await PushSubscription.deleteOne({ endpoint, user: req.user._id });
  res.status(200).json({ subscribed: false });
});

// GET /api/push/prefs
export const getPushPrefs = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id).select("pushPrefs").lean();
  res.status(200).json({ pushPrefs: user?.pushPrefs || {} });
});

// PUT /api/push/prefs — partial update; only keys present in the body
// are touched, so the frontend can send a single toggle's new value
// instead of the whole prefs object every time.
export const updatePushPrefs = asyncHandler(async (req, res) => {
  const { pushPrefs } = req.body;

  const setOps = {};
  for (const [key, value] of Object.entries(pushPrefs)) {
    setOps[`pushPrefs.${key}`] = value;
  }

  const user = await User.findByIdAndUpdate(
    req.user._id,
    { $set: setOps },
    { new: true, runValidators: true },
  ).select("pushPrefs");

  res.status(200).json({ pushPrefs: user.pushPrefs });
});
