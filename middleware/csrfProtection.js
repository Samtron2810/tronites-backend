import getAllowedOrigins from "../config/allowedOrigins.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// Cookie auth needs SameSite=None in production — the frontend (Vercel)
// and backend (Render) are on different origins, so SameSite=Lax/Strict
// would break every legitimate cross-origin request too. But
// SameSite=None cookies are attached on cross-site requests as well,
// which is exactly what CSRF exploits, and CORS doesn't close that gap:
// CORS only stops a cross-origin script from reading the response, not
// from sending the state-changing request in the first place — a plain
// HTML form POST from an attacker's page never triggers a CORS
// preflight at all, and the server still processes it, cookie and all.
//
// This middleware closes that gap directly: for any state-changing
// request, the Origin (or Referer's origin, if Origin is absent) must be
// one of this app's own allowed frontend origins, or the request is
// rejected before any route handler — and therefore before any
// database write — runs.
const csrfProtection = (req, res, next) => {
  if (SAFE_METHODS.has(req.method)) {
    return next();
  }

  const origin = req.get("origin");
  const referer = req.get("referer");
  const allowedOrigins = getAllowedOrigins();

  // Origin is a single, unambiguous value browsers attach to
  // cross-origin requests (and most same-origin state-changing ones).
  // Referer is only used as a fallback for the rare legitimate request
  // that omits Origin, and only its origin component is compared — the
  // path/query of a Referer is never trustworthy input.
  let requestOrigin = origin;
  if (!requestOrigin && referer) {
    try {
      requestOrigin = new URL(referer).origin;
    } catch {
      requestOrigin = null;
    }
  }

  if (!requestOrigin || !allowedOrigins.includes(requestOrigin)) {
    return res.status(403).json({
      message: "Request rejected: origin not allowed.",
    });
  }

  next();
};

export default csrfProtection;
