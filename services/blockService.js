import Block from "../models/Block.js";

// Is there a block between these two users in either direction?
export const isBlockedEitherWay = async (userA, userB) => {
  const edge = await Block.exists({
    $or: [
      { blocker: userA, blocked: userB },
      { blocker: userB, blocked: userA },
    ],
  });
  return Boolean(edge);
};

// Did `blockerId` specifically block `blockedId`? (directional — used to
// show the correct "Block"/"Unblock" label on the blocker's own screen)
export const hasBlocked = async (blockerId, blockedId) => {
  const edge = await Block.exists({ blocker: blockerId, blocked: blockedId });
  return Boolean(edge);
};

// Full set of user IDs that have any block relationship with `userId`
// (either direction) as a Set of strings — the shape every "filter this
// list against my blocks" call site below needs. One query, reused for
// feed filtering, mention filtering, comment visibility, and
// notification suppression, instead of N pairwise isBlockedEitherWay()
// calls per list.
export const getBlockedEitherWayIds = async (userId) => {
  const edges = await Block.find({
    $or: [{ blocker: userId }, { blocked: userId }],
  })
    .select("blocker blocked")
    .lean();

  const ids = new Set();
  for (const e of edges) {
    const blocker = e.blocker.toString();
    const blocked = e.blocked.toString();
    ids.add(blocker === userId.toString() ? blocked : blocker);
  }
  return ids;
};

// Every block edge involving a user, in either direction — used for
// account deletion so no Block row is left referencing a purged user
// (as either the blocker or the one blocked).
export const removeAllBlockEdgesForUser = (userId) =>
  Block.deleteMany({ $or: [{ blocker: userId }, { blocked: userId }] });
