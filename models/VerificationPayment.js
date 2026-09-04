import mongoose from "mongoose";

// Tracks a Paystack charge for a business badge application.
// One document per initiation — a user who abandons and retries gets a
// fresh document; stale ones are left as-is (audit trail).
// Only a verified payment unlocks VerificationRequest creation.
const verificationPaymentSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    // Paystack's opaque reference — used to verify/query the charge.
    // Unique so a reference can't be replayed across users.
    reference: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },

    // Amount charged in kobo (Paystack's base unit for NGN).
    // Stored so the record is self-describing even if env changes later.
    amountKobo: {
      type: Number,
      required: true,
    },

    // "initiated" → user was sent to Paystack checkout.
    // "verified"  → Paystack confirmed success; submission unlocked.
    // "failed"    → Paystack returned a non-success status on verify.
    status: {
      type: String,
      enum: ["initiated", "verified", "failed"],
      default: "initiated",
    },

    // Paystack's raw status string from the verify response — kept for
    // support debugging ("abandoned", "failed", etc.)
    paystackStatus: {
      type: String,
      default: "",
    },

    // Set once consumed by VerificationRequest creation, so the same
    // payment can't fund two submissions.
    consumedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true },
);

// Fast lookup by user+status (can I skip the payment step? / list open
// payments). `reference` doesn't need a schema.index() — its `unique: true`
// field option above already creates the index for the verify flow.
verificationPaymentSchema.index({ user: 1, status: 1 });

const VerificationPayment = mongoose.model(
  "VerificationPayment",
  verificationPaymentSchema,
);

export default VerificationPayment;
