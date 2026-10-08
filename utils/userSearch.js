// Shared helpers for indexed user search (models/User.js, userController,
// scripts/backfillUserNameSearch.js). Pure functions — no imports, so the
// model can use them without circular dependencies.

export const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// "Mary-Jane O'Neil" -> ["mary", "jane", "o", "neil"]
export const nameToTokens = (name) =>
  [...new Set(String(name || "").toLowerCase().split(/[\s'’-]+/).filter(Boolean))];

// Anchored, case-sensitive prefix match against lowercase fields so Mongo
// can use an index range scan. `username` is already stored lowercase.
export const buildPrefixFilter = (query) => {
  const q = String(query).toLowerCase();
  const prefix = new RegExp(`^${escapeRegex(q)}`);
  return {
    $or: [{ username: prefix }, { nameLower: prefix }, { nameTokens: prefix }],
  };
};

// The original behavior: case-insensitive substring on name/username.
export const buildSubstringFilter = (query) => {
  const rx = escapeRegex(String(query));
  return {
    $or: [
      { name: { $regex: rx, $options: "i" } },
      { username: { $regex: rx, $options: "i" } },
    ],
  };
};
