import mongoose from "mongoose";

// Phase 5 — every permission the system knows about. Single source of
// truth for the model enum; middleware and controllers derive behavior
// from these names.
export const PERMISSIONS = [
  "manage_reports",
  "manage_users",
  "manage_content",
  "view_audit_log",
  "manage_roles",
];

// What a moderator could do BEFORE granular permissions existed (Phases
// 2–4 shipped suspend/unrestrict/warn to the coarse requireModerator
// gate). Applied whenever a moderator's explicit permissions array is
// empty — both as the seed on promotion and as the runtime fallback in
// requirePermission — so existing accounts never lose capabilities in the
// migration. Note this intentionally exceeds the plan-doc's original
// two-permission example: Phase 2 gave moderators suspension, and taking
// that away silently would be a regression, not a cleanup.
export const DEFAULT_MODERATOR_PERMISSIONS = [
  "manage_reports",
  "manage_users",
  "manage_content",
];

const userSchema = new mongoose.Schema(
  {
    firstName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 30,
      match: /^[\p{L}\p{M}][\p{L}\p{M}' -]*$/u,
    },

    lastName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 30,
      match: /^[\p{L}\p{M}][\p{L}\p{M}' -]*$/u,
    },

    // Derived display name (`${firstName} ${lastName}`), stored so every
    // existing read site (DTOs, search index, mention suggestions, etc.)
    // keeps working unchanged. Kept in sync in the pre-save hook below —
    // never set directly by callers.
    name: {
      type: String,
      required: true,
    },

    // Nullable until the post-signup "choose your username" step
    // completes — null means the account exists but onboarding isn't
    // finished. sparse:true lets multiple docs have null without
    // violating the unique index.
    username: {
      type: String,
      unique: true,
      sparse: true,
      trim: true,
      lowercase: true,
      minlength: 3,
      maxlength: 20,
      match: /^[a-z0-9_]+$/,
      default: null,
    },

    email: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
    },

    password: {
      type: String,
      required: true,
    },

    // Set whenever the password is changed (reset flow). The auth
    // middleware compares each JWT's `iat` against this timestamp: any
    // token issued before the change is rejected, which invalidates all
    // existing sessions (including stolen cookies) after a reset.
    passwordChangedAt: {
      type: Date,
      default: null,
    },

    bio: {
      type: String,
      default: "",
      maxlength: 150,
    },

    profilePic: {
      type: String,
      default: "",
    },

    // Who can see this user's online/offline status. "everyone" matches
    // the historical (pre-P0.7) behavior. "followers" limits it to
    // people this user follows back — i.e. connections, not just anyone
    // who chose to follow them. "nobody" hides it from all other users
    // entirely, including mutuals. Default stays "everyone" so existing
    // users see no behavior change unless they opt into more privacy.
    presenceVisibility: {
      type: String,
      enum: ["everyone", "followers", "nobody"],
      default: "everyone",
    },

    // Gates the moderation queue (list/resolve reports). Only ever set
    // directly in the database or by an existing admin via a future
    // admin tool — there is no self-service endpoint that changes this,
    // so a compromised or malicious regular account can never grant
    // itself moderator access through the API.
    role: {
      type: String,
      enum: ["user", "moderator", "admin"],
      default: "user",
    },

    // Phase 5 — granular moderation permissions (meaningful only for the
    // "moderator" role; admins implicitly hold every permission via the
    // short-circuit in middleware/requirePermission.js, and plain users
    // hold none). An explicit non-empty array is authoritative — that's
    // what lets an admin REVOKE a capability a moderator would otherwise
    // have by default. An EMPTY array on a moderator falls back to
    // DEFAULT_MODERATOR_PERMISSIONS at gate time, so pre-granular rows
    // keep working unchanged. Kept in sync with the zod enum in
    // utils/validators.js (updatePermissionsSchema) — same duplication
    // tradeoff as AUDIT_ACTIONS.
    permissions: {
      type: [String],
      enum: [
        "manage_reports",
        "manage_users",
        "manage_content",
        "view_audit_log",
        "manage_roles",
      ],
      default: [],
    },

    // Phase 2 account restrictions (see adminController.suspendUser /
    // banUser / unrestrictUser). checked on EVERY authenticated request
    // by authMiddleware — so unlike deletedAt (which only blocks new
    // logins plus its authMiddleware branch), a restriction lands on the
    // user's very next API call even mid-session. suspendedUntil null =
    // not suspended; banned true is permanent pending manual reversal.
    // restrictionReason is moderator-facing context, never exposed
    // outside admin/moderator-gated responses.
    suspendedUntil: {
      type: Date,
      default: null,
    },
    banned: {
      type: Boolean,
      default: false,
    },
    restrictionReason: {
      type: String,
      default: "",
      trim: true,
      maxlength: 500,
    },

    // Phase 4 — formal warnings ("strikes"). Each entry is one warning
    // issued by a moderator/admin via POST /admin/users/:id/warn. Like
    // the restriction fields above, this is a moderator-only fact: it
    // never appears in toPublicUserDTO/toPrivateSelfDTO — only its COUNT
    // surfaces, through toAdminUserDTO.strikesCount for the admin panel.
    // Crossing STRIKE_THRESHOLD (adminController) makes the FRONTEND
    // prompt the moderator to consider a suspension; the backend never
    // auto-suspends — a human decides what repeated warnings mean.
    strikes: [
      {
        reason: { type: String, default: "", trim: true, maxlength: 500 },
        moderator: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
          default: null,
        },
        // Optional back-reference to the queue item that prompted this
        // warning, for audit-trail cross-checking.
        reportId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Report",
          default: null,
        },
        createdAt: { type: Date, default: Date.now },
      },
    ],

    // Soft-delete for account deletion (NDPR/GDPR "right to erasure").
    // Set the instant a user confirms deletion — the account becomes
    // immediately unusable (login rejected, profile/posts hidden from
    // other users) but the row itself isn't hard-deleted yet, so a
    // deletion within the grace window can still be reversed by
    // contacting support. The scheduled purge job
    // (jobs/purgeDeletedAccounts.js) hard-deletes the user and cascades
    // through every collection referencing them once deletedAt is older
    // than the grace period (see services/accountDeletionService.js).
    deletedAt: {
      type: Date,
      default: null,
      index: true,
    },
  },
  { timestamps: true },
);

// Keep `name` derived from firstName/lastName on every save, so nothing
// downstream (DTOs, text search, sockets) needs to know the split exists.
//
// Mongoose 9 removed callback-style middleware: sync hooks receive no
// `next` argument (calling it throws "next is not a function") — see
// models/Message.js for the async-hook equivalent of the new style.
userSchema.pre("validate", function () {
  if (this.firstName || this.lastName) {
    this.name = `${this.firstName || ""} ${this.lastName || ""}`.trim();
  }
});

// Indexes (email is already indexed via `unique: true` in the schema)
userSchema.index({ name: 1 });

const User = mongoose.model("User", userSchema);

export default User;
