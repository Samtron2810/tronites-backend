import VerificationRequest from "../models/VerificationRequest.js";

// Privacy Policy §Identity verification: application data (legal name,
// date of birth, country, statement, links) is kept for the review and for
// up to 12 months after the application is resolved, then deleted. Pending
// requests are never touched. Payment records live in VerificationPayment
// and are retained separately.
export const VERIFICATION_DATA_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;

export const purgeVerificationData = async () => {
  try {
    const cutoff = new Date(Date.now() - VERIFICATION_DATA_RETENTION_MS);
    const result = await VerificationRequest.deleteMany({
      status: { $in: ["approved", "denied"] },
      reviewedAt: { $ne: null, $lt: cutoff },
    });
    if (result.deletedCount) {
      console.log(
        `Purged ${result.deletedCount} resolved verification application(s) older than 12 months.`,
      );
    }
  } catch (error) {
    console.error("Verification data purge failed:", error.message);
  }
};
