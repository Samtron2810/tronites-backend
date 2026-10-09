// ONE-OFF, NOT RUN AUTOMATICALLY.
//
// Before the opt-in change, every account was created with
// marketingEmailOptOut:false, i.e. "subscribed" without ever being asked.
// The Privacy Policy now says marketing email is opt-in only, so this sets
// everyone who never made an explicit choice back to opted-out.
//
// Accounts that already changed the setting themselves (marketingEmailsSetAt
// present) are left alone.
//
//   node maintenance/resetMarketingConsent.js          # dry run (counts only)
//   node maintenance/resetMarketingConsent.js --apply  # write the change
import "../config/loadEnv.js";
import mongoose from "mongoose";
import User from "../models/User.js";

const apply = process.argv.includes("--apply");

const filter = {
  marketingEmailOptOut: { $ne: true },
  marketingEmailsSetAt: null,
};

try {
  await mongoose.connect(process.env.MONGO_URI);
  const count = await User.countDocuments(filter);
  console.log(`${count} account(s) would be set to marketing opt-out.`);
  if (apply) {
    const res = await User.updateMany(filter, {
      $set: { marketingEmailOptOut: true },
    });
    console.log(`Updated ${res.modifiedCount} account(s).`);
  } else {
    console.log("Dry run — pass --apply to write.");
  }
} finally {
  await mongoose.disconnect();
}
