// Explicit include-lists for shaping User documents into API responses.
//
// The bug this replaces: `User.findById(id).select("-password")` defines
// a response by what it EXCLUDES. That's fragile in one specific way — it
// silently starts leaking again the moment a new sensitive field (email
// today, maybe a reset-token or a private setting tomorrow) is added to
// the User model and whoever adds it forgets to also add it to every
// exclusion list in the codebase. An include-list can't leak a field it
// doesn't name, regardless of what gets added to the schema later.

// Fields safe to show to ANY authenticated user viewing someone else's
// profile.
export const toPublicUserDTO = (user) => {
  if (!user) return null;
  const u = typeof user.toObject === "function" ? user.toObject() : user;

  return {
    _id: u._id,
    name: u.name,
    username: u.username,
    bio: u.bio,
    profilePic: u.profilePic,
  };
};

// Public fields plus the account owner's own private data. Only ever pass
// this to a response when the requester IS this user — callers are
// responsible for that check, this function doesn't (and can't) verify it.
export const toPrivateSelfDTO = (user) => {
  if (!user) return null;
  const u = typeof user.toObject === "function" ? user.toObject() : user;

  return {
    ...toPublicUserDTO(u),
    email: u.email,
    // Gates the moderation queue entry point in the user menu. Never included in
    // toPublicUserDTO — other users' roles are nobody else's business,
    // and showing it publicly would let anyone enumerate moderators.
    role: u.role,
    // Phase 5 — same authorization-flag rationale as role: the client
    // needs its OWN permissions to decide which moderation UI to offer
    // (queue access, audit-log link). Never public.
    permissions: Array.isArray(u.permissions) ? u.permissions : [],
    presenceVisibility: u.presenceVisibility,
  };
};

// Public fields plus role AND restriction status — for an admin viewing/
// managing arbitrary users. Restriction fields are the admin-panel's
// working data (status badges, restore actions); they're gated by
// requireAdmin at every route that returns this DTO and never appear in
// toPublicUserDTO/toPrivateSelfDTO. `suspendedUntil` is raw — the client
// derives "currently suspended" by comparing against its own clock.
export const toAdminUserDTO = (user) => {
  if (!user) return null;
  const u = typeof user.toObject === "function" ? user.toObject() : user;

  return {
    ...toPublicUserDTO(u),
    email: u.email,
    role: u.role,
    createdAt: u.createdAt,
    banned: Boolean(u.banned),
    suspendedUntil: u.suspendedUntil || null,
    restrictionReason: u.restrictionReason || "",
    // Count only, never the strike entries themselves (their
    // reasons are between the moderation team and the audit log).
    strikesCount: Array.isArray(u.strikes) ? u.strikes.length : 0,
    // Phase 5 — admin rows need the live permission set for the editor.
    permissions: Array.isArray(u.permissions) ? u.permissions : [],
  };
};
