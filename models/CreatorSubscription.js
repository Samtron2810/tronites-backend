import mongoose from "mongoose";

// A subscription plan created by a creator. One creator can have one active plan.
// Prices in NGN kobo (Paystack's base unit), billed monthly.
const creatorPlanSchema = new mongoose.Schema(
  {
    creator: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true, // one plan per creator
    },

    // Display name for the plan — shown on the creator's profile.
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 60,
    },

    // What subscribers get — shown on the subscribe modal.
    perks: {
      type: String,
      default: "",
      trim: true,
      maxlength: 300,
    },

    // Monthly price in NGN (whole naira, stored as integer to avoid fp).
    priceNgn: {
      type: Number,
      required: true,
      min: 100, // minimum ₦100/month
    },

    // Whether the plan is currently accepting new subscribers.
    active: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true },
);

export const CreatorPlan = mongoose.model("CreatorPlan", creatorPlanSchema);

// One document per active/cancelled subscriber relationship.
const creatorSubscriptionSchema = new mongoose.Schema(
  {
    subscriber: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    creator: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    plan: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CreatorPlan",
      required: true,
    },

    // "active"    → subscription is live, subscriber can see subscriber-only posts.
    // "cancelled" → user cancelled; currentPeriodEnd is when access lapses.
    // "expired"   → past currentPeriodEnd after cancellation; access revoked.
    // "failed"    → recurring charge failed; treated like expired for access checks.
    status: {
      type: String,
      enum: ["active", "cancelled", "expired", "failed"],
      default: "active",
    },

    // When the current paid period ends. Access is valid through this date.
    currentPeriodEnd: {
      type: Date,
      required: true,
    },

    // Paystack authorization code for future recurring charges.
    paystackAuthCode: {
      type: String,
      default: null,
    },

    // Paystack customer code for the subscriber's wallet.
    paystackCustomerCode: {
      type: String,
      default: null,
    },

    // Email used for the Paystack customer — stored so renewal charges can
    // be initiated server-side without hitting the User model each time.
    subscriberEmail: {
      type: String,
      required: true,
    },

    // Paystack reference of the most recent successful charge.
    lastChargeReference: {
      type: String,
      default: null,
    },

    // ISO date of the last successful charge.
    lastChargedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true },
);

// Unique constraint: one active sub per subscriber-creator pair.
creatorSubscriptionSchema.index({ subscriber: 1, creator: 1 }, { unique: true });
creatorSubscriptionSchema.index({ creator: 1, status: 1 });
// Lets the renewal job cheaply find subs due for charge.
creatorSubscriptionSchema.index({ status: 1, currentPeriodEnd: 1 });

export const CreatorSubscription = mongoose.model(
  "CreatorSubscription",
  creatorSubscriptionSchema,
);
