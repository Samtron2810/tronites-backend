// Centralized error handler — the last middleware in the chain (see
// index.js). Only actually reached for: (1) routes wrapped in
// asyncHandler whose promise rejected, (2) a synchronous throw inside a
// non-async handler, or (3) next(err) called explicitly. Most existing
// controllers still catch their own errors and respond directly (see
// asyncHandler.js's comment on incremental adoption) — this exists so an
// uncaught error doesn't crash the process or leak a raw stack trace to
// the client, whichever path it arrived by.
const errorHandler = (err, req, res, next) => {
  // Express itself may already have started writing a response (e.g. a
  // stream) — can't set headers again in that case, so hand off to
  // Express's default handler rather than double-responding.
  if (res.headersSent) {
    return next(err);
  }

  let statusCode = err.statusCode || err.httpStatus || 500;
  let message = err.message || "Something went wrong.";

  // Mongoose CastError — malformed ObjectId in a route param, e.g.
  // GET /posts/not-a-valid-id. Worth a 400 (bad input) rather than the
  // 500 it'd otherwise surface as.
  if (err.name === "CastError") {
    statusCode = 400;
    message = `Invalid ${err.path}: ${err.value}`;
  }

  // Mongoose schema validation failure that reached here uncaught.
  if (err.name === "ValidationError") {
    statusCode = 400;
    message = Object.values(err.errors)
      .map((e) => e.message)
      .join(", ");
  }

  // Duplicate key (unique index violation) that reached here uncaught —
  // most of the codebase's own unique-index races (likes, follows,
  // bookmarks) already catch their own E11000 and treat it as an
  // idempotent no-op (see createLikeEdge and friends), so reaching this
  // branch usually means a *different* unique index than the ones this
  // codebase treats as expected/racy.
  if (err.code === 11000) {
    statusCode = 409;
    const field = Object.keys(err.keyPattern || {})[0] || "field";
    message = `That ${field} is already in use.`;
  }

  // Multer's file-size/file-count errors carry a `code` like
  // LIMIT_FILE_SIZE — surfaced as 400s instead of 500s.
  if (err.name === "MulterError") {
    statusCode = 400;
  }

  if (process.env.NODE_ENV !== "production") {
    console.error(err.stack || err);
  } else if (statusCode >= 500) {
    // Don't spam logs with expected 4xx client errors in production,
    // but still surface anything that reached this handler as a 500.
    console.error(err.message);
  }

  res.status(statusCode).json({
    message,
    ...(process.env.NODE_ENV !== "production" && { stack: err.stack }),
  });
};

export default errorHandler;
