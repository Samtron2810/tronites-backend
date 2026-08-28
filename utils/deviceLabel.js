import { UAParser } from "ua-parser-js";

// Turns a raw User-Agent string into something a user can recognize at a
// glance on the Sessions screen — "Chrome on Android", "Safari on iPhone"
// — instead of dumping the full UA string. Falls back to "Unknown device"
// rather than throwing on a malformed/empty UA (some clients send none).
export const parseDeviceLabel = (userAgent) => {
  if (!userAgent) return "Unknown device";

  const { browser, os, device } = new UAParser(userAgent).getResult();

  const browserName = browser.name || "Unknown browser";
  // Prefer the device model (e.g. "iPhone") over the raw OS name when
  // present — it's more recognizable than "iOS 17" to most users.
  const platform = device.model || os.name || "Unknown OS";

  return `${browserName} on ${platform}`;
};

// Coarse device-type bucket for choosing an icon client-side, so the
// frontend doesn't need to re-parse the UA string itself.
export const parseDeviceType = (userAgent) => {
  if (!userAgent) return "desktop";
  const { device } = new UAParser(userAgent).getResult();
  if (device.type === "mobile") return "mobile";
  if (device.type === "tablet") return "tablet";
  return "desktop";
};
