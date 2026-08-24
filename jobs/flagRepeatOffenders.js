import Report from "../models/Report.js";

// Phase 6 — proactive repeat-offender flagging. Runs at boot then hourly,
// same cadence as cleanupAbandonedVideoShells / purgeDeletedAccounts (see
// index.js). Finds accounts whose OPEN reports from the last 24h reach
// REPEAT_OFFENDER_THRESHOLD and raises those reports to priority "high"
// so the pile-up surfaces at the top of the moderation queue instead of
// waiting for someone to notice the pile-up itself.
//
// Deliberately does NOT synthesize new reports (the plan doc offered that
// as an alternative): synthetic rows would need a fabricated reporter,
// poisoning reporter-integrity assumptions elsewhere (unique
// reporter+target idempotency, audit trails). Raising real rows is
// idempotent by construction — only priority:"normal" documents match —
// so a crash mid-sweep simply means the next run finishes the job.

export const REPEAT_OFFENDER_THRESHOLD = 5;
const WINDOW_MS = 24 * 60 * 60 * 1000;

export const flagRepeatOffenders = async () => {
  try {
    const cutoff = new Date(Date.now() - WINDOW_MS);

    const offenders = await Report.aggregate([
      { $match: { status: "open", createdAt: { $gte: cutoff } } },
      { $group: { _id: "$targetOwner", openCount: { $sum: 1 } } },
      { $match: { openCount: { $gte: REPEAT_OFFENDER_THRESHOLD } } },
    ]);

    if (!offenders.length) return { ownersFlagged: 0, reportsRaised: 0 };

    let reportsRaised = 0;
    for (const offender of offenders) {
      const res = await Report.updateMany(
        {
          targetOwner: offender._id,
          status: "open",
          priority: "normal",
        },
        { $set: { priority: "high" } },
      );
      reportsRaised += res.modifiedCount || 0;
    }

    if (reportsRaised > 0) {
      console.log(
        `[flagRepeatOffenders] ${offenders.length} account(s) at ${REPEAT_OFFENDER_THRESHOLD}+ open reports/24h; raised ${reportsRaised} report(s) to high priority.`,
      );
    }
    return { ownersFlagged: offenders.length, reportsRaised };
  } catch (error) {
    // A background sweep must never crash the process.
    console.error("[flagRepeatOffenders] failed:", error.message);
    return { ownersFlagged: 0, reportsRaised: 0 };
  }
};
