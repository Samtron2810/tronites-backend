import mongoose from "mongoose";

// A one-time tip from any authenticated user to a creator.
// Paystack handles the charge; this record is created after
// the transaction is verified.
const creatorTipSchema = new mongoose.Schema(
  {
    // Who sent the tip.
    sender: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    // Creator who receives the tip.
    creator: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    // Optional post context — a tip can be tied to a specific post
    // ("I loved this post") or standalone (from the creator's profile).
    post: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Post",
      default: null,
    },

    // Amount in NGN kobo (Paystack's base unit).
    amountKobo: {
      type: Number,
      required: true,
    },

    // Paystack transaction reference — unique, used to verify and de-dup.
    reference: {
      type: String,
      required: true,
      unique: true,
    },

    // "initiated" → Paystack checkout started but not verified yet.
    // "verified"  → Paystack confirmed success.
    // "failed"    → Paystack returned non-success on verify.
    status: {
      type: String,
      enum: ["initiated", "verified", "failed"],
      default: "initiated",
    },

    // Optional message from sender (up to 150 chars, shown to creator).
    message: {
      type: String,
      default: "",
      trim: true,
      maxlength: 150,
    },

    // Whether the sender consented to show their name to the creator.
    // false = anonymous tip.
    isAnonymous: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true },
);

// Fast lookup by creator for earnings summary.
creatorTipSchema.index({ creator: 1, status: 1, createdAt: -1 });
// Fast lookup by sender for "my tips sent" history.
creatorTipSchema.index({ sender: 1, createdAt: -1 });

const CreatorTip = mongoose.model("CreatorTip", creatorTipSchema);
export default CreatorTip;
