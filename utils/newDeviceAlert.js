import Session from "../models/Session.js";
import { sendEmail } from "./brevoEmail.js";
import { newDeviceLoginTemplate } from "./emailTemplate.js";
import { parseDeviceLabel } from "./deviceLabel.js";

// Fires (does not await-block the caller) a "new device" email if this
// login's userAgent doesn't match any *other* session already on file
// for the user. Must be called AFTER issueSession has created the new
// Session doc, so the query excludes it via excludeSessionId — otherwise
// every login would look "new" since its own just-created doc matches.
//
// Deliberately swallow-all on error: an email failure (Brevo down, bad
// API key) must never surface as a login failure. This is a best-effort
// notification, not part of the auth contract.
export const maybeSendNewDeviceAlert = async ({
  userId,
  email,
  userAgent,
  ip,
  excludeSessionId,
}) => {
  try {
    if (!userAgent) return; // Nothing to compare/display — skip silently.

    const seenBefore = await Session.exists({
      user: userId,
      userAgent,
      _id: { $ne: excludeSessionId },
    });

    if (seenBefore) return;

    await sendEmail({
      to: email,
      subject: "New sign-in to your Tronites account",
      htmlContent: newDeviceLoginTemplate({
        device: parseDeviceLabel(userAgent),
        ip,
        time: new Date().toUTCString(),
      }),
    });
  } catch (err) {
    console.error("New-device alert failed:", err.message);
  }
};
