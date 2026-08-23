import User from "../models/User.js";
import { hardDeleteAccount, DELETION_GRACE_PERIOD_MS } from "../services/accountDeletionService.js";

// Sweeps for accounts soft-deleted (User.deletedAt set) more than
// DELETION_GRACE_PERIOD_MS ago and runs the full hard-delete cascade on
// each. Deliberately processed one at a time rather than in parallel —
// each hard delete already fans out into many collections internally;
// running several full account purges concurrently multiplies that
// fan-out for no real speed benefit, since this runs on an hourly
// schedule and isn't latency-sensitive.
export const purgeDeletedAccounts = async () => {
  try {
    const cutoff = new Date(Date.now() - DELETION_GRACE_PERIOD_MS);

    const due = await User.find({
      deletedAt: { $ne: null, $lt: cutoff },
    }).select("_id");

    if (!due.length) return;

    for (const user of due) {
      try {
        await hardDeleteAccount(user._id);
      } catch (err) {
        // One account's purge failing (e.g. a transient DB error)
        // shouldn't block the rest of the sweep — it'll simply be
        // retried on the next hourly run since deletedAt is untouched
        // until hardDeleteAccount's final User.deleteOne succeeds.
        console.error(`Failed to purge account ${user._id}:`, err.message);
      }
    }

    console.log(`Purged ${due.length} account(s) past their deletion grace period.`);
  } catch (error) {
    console.error("Account purge sweep failed:", error.message);
  }
};
