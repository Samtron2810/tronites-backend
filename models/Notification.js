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
      required: true,
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
        // 1.1 — repost/quote notification. Same row shape for both:
        // `post` always points at the ORIGINAL post, never the quote
        // (a quote has no Post document of its own — see
        // models/Repost.js — so there's nothing else it could point
        // at). The recipient's notifications page can't currently tell
        // a plain repost from a quote apart from this type alone; that
        // distinction isn't needed for the notification text itself
        // ("X reposted your post" reads fine for both), only for
        // whether the frontend deep-links to the quote's own text.
        "repost",
        // Phase 4 — formal moderator warning. Rendered specially by the
        // notifications page: reason text from `message`, sender identity
        // never displayed (the warned user sees "Moderation team", not
        // which moderator issued it).
        "moderator_warning",
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
