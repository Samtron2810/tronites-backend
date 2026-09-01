import mongoose from "mongoose";

// One document per browser subscription (endpoint), not per user — a
// user with phone + laptop + a reinstalled PWA has multiple endpoints,
// all live at once. Fan-out iterates every doc for a user; a dead
// endpoint (410/404 from the push service) is deleted individually
// without touching the others. Mirrors the Session.js convention:
// device-scoped rows under a `user` ref, TTL-free (subscriptions don't
// expire on a timer — they die when the push service rejects them).
const pushSubscriptionSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    // The three fields the Web Push protocol needs verbatim — this is
    // exactly the shape PushSubscription.toJSON() gives the frontend,
    // stored as-is so pushService can hand it straight to web-push
    // without reshaping.
    endpoint: {
      type: String,
      required: true,
      unique: true,
    },
    keys: {
      p256dh: { type: String, required: true },
      auth: { type: String, required: true },
    },

    userAgent: { type: String, default: "" },
    lastSeenAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

pushSubscriptionSchema.index({ user: 1, endpoint: 1 });

export default mongoose.model("PushSubscription", pushSubscriptionSchema);
