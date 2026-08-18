import Mute from "../models/Mute.js";

// Did `muterId` mute `mutedId`?
export const hasMuted = async (muterId, mutedId) => {
  const edge = await Mute.exists({ muter: muterId, muted: mutedId });
  return Boolean(edge);
};

// Set of user IDs `userId` has muted — used to filter `userId`'s own
// feed and notification stream. One-directional by design: being muted
// by someone else never affects what you see.
export const getMutedIds = async (userId) => {
  const edges = await Mute.find({ muter: userId }).select("muted").lean();
  return new Set(edges.map((e) => e.muted.toString()));
};

export const muteUser = async (muterId, mutedId) => {
  await Mute.create({ muter: muterId, muted: mutedId }).catch((err) => {
    if (err.code !== 11000) throw err; // already muted — no-op
  });
};

export const unmuteUser = async (muterId, mutedId) => {
  await Mute.deleteOne({ muter: muterId, muted: mutedId });
};
