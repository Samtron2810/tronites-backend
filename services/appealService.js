import bcrypt from "bcryptjs";
import Appeal from "../models/Appeal.js";
import User from "../models/User.js";

const httpError = (statusCode, message) => {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
};

// Same timing-safety trick as authController's loginUser — a dummy hash
// so "no such account" and "wrong password" take about the same time.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync(
  "dummy-password-for-timing-safety",
  10,
);

// Submits an appeal. Credential-based rather than cookie-based by
// necessity: authMiddleware and loginUser both hard-reject a restricted
// account before it ever reaches a `protect`-gated route, so there is no
// session to attach this to. identifier+password re-proves ownership the
// same way loginUser already does for a restricted account, just without
// then issuing a session.
export const submitAppeal = async ({ identifier, password, statement }) => {
  const query = identifier.includes("@")
    ? { email: identifier.trim().toLowerCase() }
    : { username: identifier.toLowerCase() };

  const user = await User.findOne(query);
  const isMatch = await bcrypt.compare(
    password,
    user ? user.password : DUMMY_PASSWORD_HASH,
  );

  if (!user || !isMatch) {
    throw httpError(400, "Invalid email/username or password.");
  }
  if (user.deletedAt) {
    throw httpError(403, "This account has been deleted.");
  }

  const isBanned = Boolean(user.banned);
  const isSuspended =
    user.suspendedUntil && new Date(user.suspendedUntil) > new Date();

  if (!isBanned && !isSuspended) {
    throw httpError(400, "This account isn't currently restricted.");
  }

  try {
    const appeal = await Appeal.create({
      user: user._id,
      restrictionType: isBanned ? "ban" : "suspension",
      restrictionReason: user.restrictionReason || "",
      suspendedUntil: isBanned ? null : user.suspendedUntil,
      statement,
    });
    return appeal;
  } catch (err) {
    // Partial unique index (user, status:"open") — a second appeal while
    // one is still pending is a duplicate, not a new plea.
    if (err.code === 11000) {
      throw httpError(409, "You already have an appeal under review.");
    }
    throw err;
  }
};

// Lets a restricted user check their own appeal's status without a
// session — same credential re-proof as submission. Used by the frontend
// restricted-screen to show "Appeal submitted, under review" instead of
// re-showing the form after a refresh.
export const getMyAppealStatus = async ({ identifier, password }) => {
  const query = identifier.includes("@")
    ? { email: identifier.trim().toLowerCase() }
    : { username: identifier.toLowerCase() };

  const user = await User.findOne(query);
  const isMatch = await bcrypt.compare(
    password,
    user ? user.password : DUMMY_PASSWORD_HASH,
  );
  if (!user || !isMatch) {
    throw httpError(400, "Invalid email/username or password.");
  }

  const appeal = await Appeal.findOne({ user: user._id }).sort({
    createdAt: -1,
  });
  return appeal;
};

// Moderator queue — open appeals oldest-first, same "nothing sits
// ignored" convention as reportService.listReports.
export const listAppeals = async ({ status = "open", page = 1, limit = 25 } = {}) => {
  const skip = (page - 1) * limit;
  const filter = status === "all" ? {} : { status };

  const [appeals, total] = await Promise.all([
    Appeal.find(filter)
      .sort({ status: 1, createdAt: 1 })
      .skip(skip)
      .limit(limit)
      .populate(
        "user",
        "name username profilePic banned suspendedUntil restrictionReason strikes",
      )
      .lean(),
    Appeal.countDocuments(filter),
  ]);

  return { appeals, total, page, totalPages: Math.ceil(total / limit) };
};

// Grant = lift the restriction (mirrors adminController.unrestrictUser's
// clear-all-three-fields update) AND resolve the appeal. Deny = resolve
// only, restriction stays exactly as-is. Both require the appeal to still
// be open — resolving twice is rejected, matching resolveReport's
// findOneAndUpdate-with-status-guard pattern.
export const resolveAppeal = async ({ appealId, moderatorId, decision, note }) => {
  if (!["granted", "denied"].includes(decision)) {
    throw httpError(400, "decision must be 'granted' or 'denied'.");
  }

  const appeal = await Appeal.findOne({ _id: appealId, status: "open" });
  if (!appeal) {
    throw httpError(404, "Appeal not found or already resolved.");
  }

  let updatedUser = null;
  if (decision === "granted") {
    updatedUser = await User.findByIdAndUpdate(
      appeal.user,
      { $set: { banned: false, suspendedUntil: null, restrictionReason: "" } },
      { returnDocument: "after", runValidators: true },
    ).select(
      "_id name username email profilePic role createdAt banned suspendedUntil restrictionReason",
    );
  }

  const updatedAppeal = await Appeal.findOneAndUpdate(
    { _id: appealId, status: "open" },
    {
      $set: {
        status: decision,
        reviewedBy: moderatorId,
        reviewedAt: new Date(),
        decisionNote: note || "",
      },
    },
    { returnDocument: "after" },
  );

  if (!updatedAppeal) {
    throw httpError(404, "Appeal not found or already resolved.");
  }

  return { appeal: updatedAppeal, user: updatedUser };
};
