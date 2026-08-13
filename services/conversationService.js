import Conversation from "../models/Conversation.js";
import { isFollowing } from "./followService.js";

export const getConversationId = (userA, userB) => {
  const participants = [userA.toString(), userB.toString()].sort();
  return `${participants[0]}_${participants[1]}`;
};

// Central gate for "can senderId message receiverId right now?"
// Returns { allowed: true, conversation } or { allowed: false, reason, code }.
// `conversation` may be null when allowed via mutual-follow with no prior
// record — callers should upsert one as "accepted" in that case so future
// checks (and the conversation list) have something to read.
export const evaluateSendPermission = async (senderId, receiverId) => {
  const conversationId = getConversationId(senderId, receiverId);

  const [mutualA, mutualB] = await Promise.all([
    isFollowing(senderId, receiverId),
    isFollowing(receiverId, senderId),
  ]);
  const isMutual = mutualA && mutualB;

  const conversation = await Conversation.findOne({ conversationId });

  if (isMutual) {
    return { allowed: true, conversation, conversationId, isMutual: true };
  }

  if (!conversation) {
    // First-ever contact between these two, and not mutual followers —
    // this send becomes a message request.
    return {
      allowed: true,
      conversation: null,
      conversationId,
      isNewRequest: true,
    };
  }

  if (conversation.status === "accepted") {
    return { allowed: true, conversation, conversationId };
  }

  if (conversation.status === "declined") {
    return {
      allowed: false,
      reason: "You can't message this user.",
      code: "DECLINED",
    };
  }

  // status === "pending"
  if (conversation.initiator.toString() === senderId.toString()) {
    return {
      allowed: false,
      reason: "Message request already sent — waiting for them to accept.",
      code: "REQUEST_PENDING",
    };
  }

  // The receiver of the original request is trying to send before
  // accepting — treat it as an implicit accept so a reply just works.
  return {
    allowed: true,
    conversation,
    conversationId,
    implicitAccept: true,
  };
};

// Called after mutual-follow becomes true (e.g. someone follows back) to
// auto-promote a pending request into an open conversation.
export const autoPromoteIfMutual = async (userA, userB) => {
  const [mutualA, mutualB] = await Promise.all([
    isFollowing(userA, userB),
    isFollowing(userB, userA),
  ]);
  if (!mutualA || !mutualB) return;

  const conversationId = getConversationId(userA, userB);
  await Conversation.updateOne(
    { conversationId, status: "pending" },
    { $set: { status: "accepted" } },
  );
};
