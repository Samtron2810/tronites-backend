import mongoose from "mongoose";

// A creator's bank account details for payouts.
const creatorBankAccountSchema = new mongoose.Schema(
  {
    creator: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
    },

    // Paystack recipient code — returned after creating a transfer recipient.
    // Used to initiate transfers without re-entering bank details.
    paystackRecipientCode: {
      type: String,
      default: null,
    },

    // Display-safe bank info (never store full account numbers unmasked).
    bankName: { type: String, default: "", trim: true, maxlength: 100 },
    accountName: { type: String, default: "", trim: true, maxlength: 120 },
    // Last 4 digits only — enough for the user to confirm, not enough to use.
    accountNumberLast4: { type: String, default: "", maxlength: 4 },
    // Paystack bank code (e.g. "057" for Zenith Bank)
    bankCode: { type: String, default: "", maxlength: 10 },
  },
  { timestamps: true },
);

export const CreatorBankAccount = mongoose.model(
  "CreatorBankAccount",
  creatorBankAccountSchema,
);

// A payout (withdrawal) request from a creator.
const creatorPayoutSchema = new mongoose.Schema(
  {
    creator: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    // Amount requested in NGN kobo.
    amountKobo: {
      type: Number,
      required: true,
    },

    // "pending"    → request submitted, not yet processed.
    // "processing" → transfer initiated with Paystack.
    // "paid"       → Paystack confirmed transfer success.
    // "failed"     → Paystack reported failure (transfer_failed webhook).
    status: {
      type: String,
      enum: ["pending", "processing", "paid", "failed"],
      default: "pending",
    },

    // Paystack transfer reference — set once the transfer is initiated.
    paystackTransferCode: {
      type: String,
      default: null,
    },

    // Our own reference sent to Paystack (tronites_payout_<payoutId>) — what
    // transfer webhooks and /transfer/verify are matched against.
    paystackReference: {
      type: String,
      default: null,
    },

    // Admin who approved/rejected the request, and when.
    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    reviewedAt: {
      type: Date,
      default: null,
    },

    // Human-readable status from Paystack's transfer event.
    paystackStatus: {
      type: String,
      default: "",
    },

    // Set when status becomes "paid" or "failed".
    resolvedAt: {
      type: Date,
      default: null,
    },

    // Failure reason, if applicable.
    failureReason: {
      type: String,
      default: "",
      trim: true,
      maxlength: 300,
    },
  },
  { timestamps: true },
);

creatorPayoutSchema.index({ creator: 1, createdAt: -1 });
creatorPayoutSchema.index({ status: 1, createdAt: -1 });
creatorPayoutSchema.index({ paystackReference: 1 }, { sparse: true });

export const CreatorPayout = mongoose.model("CreatorPayout", creatorPayoutSchema);
