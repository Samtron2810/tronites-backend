import jwt from "jsonwebtoken";

const AUTH_COOKIE_NAME = "token";

// Single source of truth for the auth cookie's attributes, shared by
// generateToken() (sets it at login) and clearAuthCookie() (clears it at
// logout). Previously logout's res.cookie() call didn't repeat
// secure/sameSite/path — an explicit Path matters here in particular:
// with no Path specified, browsers derive a default from the *current
// request's* URL directory, not a fixed "/". Login, verify-otp, and
// logout all happen to live under the same /api/auth prefix today, so it
// worked by coincidence, but that's fragile — moving any of these routes
// would silently leave the real session cookie behind after "logout".
// An explicit path: "/" here removes that dependency on route layout
// entirely.
const baseCookieOptions = () => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
  path: "/",
});

const generateToken = (res, userId) => {
  const token = jwt.sign({ userId }, process.env.JWT_SECRET, {
    expiresIn: "7d",
  });

  res.cookie(AUTH_COOKIE_NAME, token, {
    ...baseCookieOptions(),
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
};

// Logout's counterpart to generateToken() — reuses the exact same
// attributes so the browser recognizes this as an overwrite of the same
// cookie (rather than a differently-scoped one) and actually clears it.
export const clearAuthCookie = (res) => {
  res.cookie(AUTH_COOKIE_NAME, "", {
    ...baseCookieOptions(),
    expires: new Date(0),
  });
};

export default generateToken;
