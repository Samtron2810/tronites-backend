// Single source of truth for age rules. MIN_SIGNUP_AGE must match the
// number quoted in the Terms of Use (§2) and Privacy Policy (§10).
export const MIN_SIGNUP_AGE = 13;
export const ADULT_AGE = 18;

const DOB_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

// Parses a strict YYYY-MM-DD string into a UTC Date. Returns null for
// malformed input or impossible calendar dates (2026-02-31, 2026-13-01…)
// instead of letting Date silently roll them over.
export const parseDateOfBirth = (value) => {
  const m = DOB_PATTERN.exec(String(value || ""));
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const d = new Date(Date.UTC(year, month - 1, day));
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month - 1 ||
    d.getUTCDate() !== day
  ) {
    return null;
  }
  return d;
};

// Whole years elapsed between `dob` and `now` (UTC calendar dates).
export const ageFromDateOfBirth = (dob, now = new Date()) => {
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const monthDiff = now.getUTCMonth() - dob.getUTCMonth();
  if (
    monthDiff < 0 ||
    (monthDiff === 0 && now.getUTCDate() < dob.getUTCDate())
  ) {
    age -= 1;
  }
  return age;
};

export const isAtLeastAge = (dob, minAge, now = new Date()) =>
  ageFromDateOfBirth(dob, now) >= minAge;
