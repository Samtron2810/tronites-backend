import "dotenv/config";
import { BrevoClient } from "@getbrevo/brevo";

// CORRECT THIS CODE

const apiKey = process.env.BREVO_API_KEY?.trim();
const senderEmail = process.env.BREVO_SENDER_EMAIL?.trim();
const senderName = process.env.BREVO_SENDER_NAME?.trim() || "Tronites";

if (!apiKey) {
  console.error(
    "BREVO_API_KEY is not set. Brevo client will not work until configured.",
  );
}

const brevo = new BrevoClient({ apiKey });

export const sendEmail = async ({ to, subject, htmlContent }) => {
  if (!apiKey) {
    throw new Error(
      "Brevo API key is not configured. Set BREVO_API_KEY in .env.",
    );
  }

  if (!senderEmail) {
    throw new Error(
      "Brevo sender email is not configured. Set BREVO_SENDER_EMAIL in .env.",
    );
  }

  try {
    const resp = await brevo.transactionalEmails.sendTransacEmail({
      htmlContent,
      sender: {
        email: senderEmail,
        name: senderName,
      },
      subject,
      to: [
        {
          email: to,
        },
      ],
      replyTo: {
        email: senderEmail,
      },
    });

    console.debug("Brevo SDK response:", resp);
    return resp;
  } catch (err) {
    // The SDK error may contain response data
    console.error("Brevo SDK error:", err);
    const msg = err?.message || JSON.stringify(err);
    throw new Error(`sendEmail failed: ${msg}`);
  }
};
