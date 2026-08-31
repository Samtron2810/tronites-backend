import mongoose from "mongoose";

// Backs both "recent searches" (auto-logged, type: "history") and
// user-pinned "saved searches" (explicit save, type: "saved") — one
// collection instead of two since the shape is identical and the only
// real difference is intent + retention (history is capped/pruned per
// user, saved is not). Replaces the old client-only localStorage
// implementation so history/saved searches survive a logout, follow the
// account across devices, and can't be wiped by clearing browser data.
const savedSearchSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    type: {
      type: String,
      enum: ["history", "saved"],
      required: true,
    },

    // Which tab this search ran against — kept so re-running a history/
    // saved entry lands back on the right tab with the right params,
    // rather than guessing from query shape.
    scope: {
      type: String,
      enum: ["posts", "comments", "messages", "users"],
      required: true,
    },

    query: {
      type: String,
      default: "",
      trim: true,
      maxlength: 280,
    },

    // Optional user-facing label for a *saved* search (e.g. "Sam's
    // media posts"). Unused for history rows.
    label: {
      type: String,
      default: "",
      trim: true,
      maxlength: 60,
    },

    // Free-form filter snapshot — from/dateRange/hasMedia/minLikes —
    // stored as-is rather than as separate typed fields so new filters
    // can be added later without a migration. Re-issuing a saved search
    // just spreads this back into the query params.
    filters: {
      from: { type: String, default: null }, // username, no @
      startDate: { type: Date, default: null },
      endDate: { type: Date, default: null },
      hasMedia: { type: Boolean, default: null },
      minLikes: { type: Number, default: null },
    },
  },
  { timestamps: true },
);

// "My recent searches, newest first" / "my saved searches, newest first".
savedSearchSchema.index({ user: 1, type: 1, createdAt: -1 });

const SavedSearch = mongoose.model("SavedSearch", savedSearchSchema);

export default SavedSearch;
