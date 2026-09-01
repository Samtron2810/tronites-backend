import webpush from "web-push";
import PushSubscription from "../models/PushSubscription.js";
import User from "../models/User.js";

// VAPID identifies this server to push services (FCM, Mozilla, Apple's
// web push relay) without a per-message auth handshake. Same "required
// or the feature silently no-ops" posture as REDIS_URL elsewhere in this
// codebase: push is optional infra, a missing key must degrade, not crash
// boot.
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:support@tronites.app";

let pushEnabled = false;

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  pushEnabled = true;
} else {
  console.warn(
    "VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY not set — Web Push is disabled. Generate a pair with `npx web-push generate-vapid-keys`.",
  );
}

export const isPushEnabled = () => pushEnabled;

// Notification.type -> User.pushPrefs key. "receiveMessage" socket events
// don't carry a Notification doc, so they're gated by "message" directly
// at the call site instead of going through this map.
const TYPE_TO_PREF_KEY = {
  like: "like",
  comment: "comment",
  follow: "follow",
  mention: "mention",
  reply: "reply",
  commentLike: "commentLike",
  repost: "repost",
  quote: "quote",
  reaction: "reaction",
};

// Human copy per notification type — kept here (not on the frontend)
// so a payload change never needs a client redeploy to take effect.
const buildNotificationCopy = (notif) => {
  const actor = notif.sender?.name || notif.sender?.username || "Someone";
  switch (notif.type) {
    case "like":
      return { title: "New like", body: `${actor} liked your post` };
    case "comment":
      return { title: "New comment", body: `${actor} commented on your post` };
    case "reply":
      return { title: "New reply", body: `${actor} replied to your comment` };
    case "commentLike":
      return { title: "New like", body: `${actor} liked your comment` };
    case "follow":
      return { title: "New follower", body: `${actor} started following you` };
    case "mention":
      return { title: "You were mentioned", body: `${actor} mentioned you` };
    case "repost":
      return { title: "New repost", body: `${actor} reposted your post` };
    case "quote":
      return { title: "New quote", body: `${actor} quoted your post` };
    case "reaction":
      return {
        title: "New reaction",
        body: `${actor} reacted ${notif.message || ""} to your post`.trim(),
      };
    default:
      return { title: "Tronites", body: "You have a new notification" };
  }
};

// Deletes a subscription that the push service has permanently rejected.
// 404/410 both mean "this endpoint no longer exists" (unsubscribed,
// browser data cleared, extension uninstalled) — anything else (network
// blip, 5xx from the push service) is left alone so a transient failure
// doesn't wipe a still-good subscription.
const isDeadSubscriptionError = (err) =>
  err?.statusCode === 404 || err?.statusCode === 410;

const sendToSubscription = async (sub, payload) => {
  try {
    await webpush.sendNotification(
      {
        endpoint: sub.endpoint,
        keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
      },
      JSON.stringify(payload),
    );
  } catch (err) {
    if (isDeadSubscriptionError(err)) {
      await PushSubscription.deleteOne({ _id: sub._id }).catch(() => {});
    } else {
      console.error("Web push send failed:", err.message);
    }
  }
};

// Fan-out to every live subscription for one user. Fire-and-forget from
// the caller's perspective (same pattern as engagementVelocityService /
// hashtagFollowService — side effects that must never block or fail the
// request that triggered them), so this function itself awaits its own
// sends but callers should not await it inline on a hot path.
const pushToUser = async (userId, payload) => {
  if (!pushEnabled || !userId) return;

  const subs = await PushSubscription.find({ user: userId }).lean();
  if (subs.length === 0) return;

  await Promise.all(subs.map((sub) => sendToSubscription(sub, payload)));
};

// Called from socket.js's emitToUser whenever a "newNotification" event
// fires. notif is the already-populated Notification doc (sender name
// available) — same object the socket event itself carries, so this
// never issues an extra query for the common case.
export const pushForNotification = async (recipientId, notif) => {
  if (!pushEnabled) return;

  const prefKey = TYPE_TO_PREF_KEY[notif.type];
  if (prefKey) {
    const user = await User.findById(recipientId).select("pushPrefs").lean();
    if (user?.pushPrefs && user.pushPrefs[prefKey] === false) return;
  }

  const { title, body } = buildNotificationCopy(notif);
  const url = notif.post ? `/post/${notif.post}` : "/notifications";

  await pushToUser(recipientId, {
    title,
    body,
    icon: "/tronite-logo.png",
    badge: "/tronite-logo.png",
    tag: `notif-${notif.type}-${notif._id}`,
    data: { url, notificationId: notif._id },
  }).catch((err) => console.error("pushForNotification failed:", err.message));
};

// Called from socket.js's emitToUser on "receiveMessage". Gated by the
// "message" pushPrefs key directly (no Notification doc exists for DMs).
export const pushForMessage = async (recipientId, message) => {
  if (!pushEnabled) return;

  const user = await User.findById(recipientId).select("pushPrefs").lean();
  if (user?.pushPrefs && user.pushPrefs.message === false) return;

  const senderName = message.sender?.name || message.sender?.username || "Someone";
  const preview = message.text
    ? message.text.slice(0, 120)
    : message.image?.length
      ? "Sent a photo"
      : message.video
        ? "Sent a video"
        : message.voice
          ? "Sent a voice note"
          : "Sent a message";

  const senderId = message.sender?._id || message.sender;

  await pushToUser(recipientId, {
    title: senderName,
    body: preview,
    icon: "/tronite-logo.png",
    badge: "/tronite-logo.png",
    tag: `dm-${senderId}`,
    data: { url: "/chat", senderId },
  }).catch((err) => console.error("pushForMessage failed:", err.message));
};

export default { isPushEnabled, pushForNotification, pushForMessage };
