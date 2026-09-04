import mongoose from "mongoose";

const notificationSchema = new mongoose.Schema(
  {
    recipient: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    sender: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      // Not required: system-generated notifications (verification
      // lifecycle, expiry job) have no human sender. The notifications
      // page branches on type rather than sender presence for these rows.
      default: null,
    },

    type: {
      type: String,
      enum: [
        "like",
        "comment",
        "follow",
        "mention",
        "reply",
        "commentLike",
        // 1.1 — repost/quote notification. `post` always points at the
        // ORIGINAL post, never the quote (a quote has no Post document
        // of its own — see models/Repost.js — so there's nothing else
        // it could point at). Plain reposts use "repost"; quotes use
        // "quote" so the notifications page can say "X quoted your
        // post" instead of the misleading "X reposted your post" — the
        // recipient sees their own quote text either way, since both
        // deep-link to the original post the quote/repost targets.
        "repost",
        "quote",
        // 1.2 — emoji reaction on a post. `message` carries the emoji
        // itself so the notifications page can render "X reacted ❤️ to
        // your post" without a second lookup — same free-text-payload
        // pattern moderator_warning uses below, just for an emoji
        // instead of a reason string.
        "reaction",
        // Phase 4 — formal moderator warning. Rendered specially by the
        // notifications page: reason text from `message`, sender identity
        // never displayed (the warned user sees "Moderation team", not
        // which moderator issued it).
        "moderator_warning",
        // Phase 5 — verification badge lifecycle.
        // verification_approved: fired when a reviewer approves an application.
        // verification_denied: fired when a reviewer denies an application.
        // verification_expired: fired by the nightly expiry job when a
        //   time-limited badge (business, creator) lapses.
        // All three have no human sender (sender: null) and carry the
        // full human-readable message in `message`.
        "verification_approved",
        "verification_denied",
        "verification_expired",
      ],
      required: true,
    },

    post: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Post",
      default: null,
    },

    comment: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Comment",
      default: null,
    },

    // Free-text payload for notifications with no post/comment context —
    // Phase 4 moderator warnings carry the warning reason here.
    message: {
      type: String,
      default: "",
      maxlength: 500,
    },

    read: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true },
);

// ADD HERE
notificationSchema.index({ recipient: 1, createdAt: -1 });
notificationSchema.index({ recipient: 1, read: 1 });

const Notification = mongoose.model("Notification", notificationSchema);

export default Notification;
