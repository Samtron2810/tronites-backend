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
