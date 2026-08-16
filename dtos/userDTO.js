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
  };
};
