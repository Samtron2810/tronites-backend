// Wraps an async route handler so a rejected promise (thrown error)
// reaches Express's error-handling middleware via next(err) instead of
// becoming an unhandled rejection. Every controller in this codebase
// currently wraps its own body in try/catch and manually does
// res.status(500).json({ message: error.message }) — this replaces that
// per-handler boilerplate with one wrapper applied at the route level,
// centralizing the response shape in errorHandler.js instead of
// repeating it in every controller.
//
// New/changed routes can adopt this incrementally — it doesn't require
// touching every existing controller at once, since a controller that
// still does its own try/catch and sends its own response works
// identically whether or not it's wrapped.
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

export default asyncHandler;
