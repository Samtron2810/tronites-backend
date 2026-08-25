import Message from "../models/Message.js";
import User from "../models/User.js";
import Conversation from "../models/Conversation.js";
import cloudinary from "../utils/cloudinary.js";
import { emitToUser } from "../socket/socket.js";

// Chat-video captions: same 30-second cap as post videos (the Cloudinary
// eager transform trims longer sources), so the signed params stay cheap to
// replay and chat threads don't get multi-minute files.
const MAX_MESSAGE_VIDEO_DURATION_SECONDS = 30;
const MESSAGE_VIDEO_FOLDER = "tronites_message_videos";
import { isBlockedEitherWay } from "../services/blockService.js";
import {
  getConversationId,
  evaluateSendPermission,
} from "../services/conversationService.js";

export const sendMessage = async (req, res) => {
  try {
    const senderId = req.user._id;
    const receiverId = req.params.userId;
    const { text } = req.body;

    if ((!text || !text.trim()) && (!req.files || req.files.length === 0)) {
      return res.status(400).json({ message: "Message cannot be empty." });
    }

    if (senderId.toString() === receiverId.toString()) {
      return res
        .status(400)
        .json({ message: "Cannot send a message to yourself." });
    }

    const receiver = await User.findById(receiverId).select("name profilePic");
    if (!receiver) {
      return res.status(404).json({ message: "Recipient not found." });
    }

    if (await isBlockedEitherWay(senderId, receiverId)) {
      return res.status(403).json({
        message: "You can't message this user.",
        code: "BLOCKED",
      });
    }

    const permission = await evaluateSendPermission(senderId, receiverId);
    if (!permission.allowed) {
      return res.status(403).json({
        message: permission.reason,
        code: permission.code,
      });
    }

    let imageUrls = [];

    // Upload up to 4 images to Cloudinary if provided
    if (req.files && req.files.length > 0) {
      try {
        for (const file of req.files) {
          const b64 = `data:${file.mimetype};base64,${file.buffer.toString("base64")}`;
          const result = await cloudinary.uploader.upload(b64, {
            folder: "tronites_messages",
            // Server-side safety net: even if a client sends an
            // uncompressed image, cap dimensions and let Cloudinary
            // auto-optimize quality/format (same pattern as post images).
            transformation: [
              {
                width: 1280,
                height: 1280,
                crop: "limit",
                quality: "auto",
                fetch_format: "auto",
              },
            ],
          });
          imageUrls.push(result.secure_url);
        }
      } catch (uploadError) {
        console.error("Image upload to Cloudinary failed:", uploadError);
        return res.status(500).json({ message: "Image upload failed." });
      }
    }

    const message = await Message.create({
      sender: senderId,
      receiver: receiverId,
      text: text?.trim() || null,
      images: imageUrls,
      conversationId: getConversationId(senderId, receiverId),
    });

    // Reflect the permission outcome in the Conversation record.
    if (permission.isNewRequest) {
      await Conversation.create({
        conversationId: permission.conversationId,
        participants: [senderId, receiverId],
        status: "pending",
        initiator: senderId,
      });
    } else if (permission.implicitAccept) {
      await Conversation.updateOne(
        { conversationId: permission.conversationId },
        { $set: { status: "accepted" } },
      );
    } else if (permission.isMutual && !permission.conversation) {
      // Mutual followers messaging for the first time — record it as
      // accepted so it's unambiguous if they later unfollow each other.
      await Conversation.create({
        conversationId: permission.conversationId,
        participants: [senderId, receiverId],
        status: "accepted",
        initiator: senderId,
      }).catch((err) => {
        // Race: another request created it first — fine, ignore.
        if (err.code !== 11000) throw err;
      });
    }

    const populatedMessage = await message.populate([
      { path: "sender", select: "_id name profilePic" },
      { path: "receiver", select: "_id name profilePic" },
    ]);

    emitToUser(receiverId, "receiveMessage", populatedMessage);

    res.status(201).json(populatedMessage);
  } catch (error) {
    console.error("SEND MESSAGE ERROR:", error);
    res.status(500).json({ message: error.message });
  }
};

// Signed browser upload: request a Cloudinary signature for a chat-video
// upload. Mirrors postController.createVideoUploadSignature — the browser
// uploads the video directly to Cloudinary (saving Express the 100MB+ memory
// hit), and the synchronous eager transform makes the response already
// contain the final trimmed/transcoded MP4, so no webhook round-trip is
// needed. The message itself is created afterwards via sendVideoMessage.
export const createMessageVideoUploadSignature = async (req, res) => {
  try {
    const timestamp = Math.round(Date.now() / 1000);
    const folder = MESSAGE_VIDEO_FOLDER;
    const eager = `so_0,du_${MAX_MESSAGE_VIDEO_DURATION_SECONDS},f_mp4,vc_h264,q_auto`;

    // Params that must be signed — Cloudinary rejects the upload if the
    // signature doesn't match these exact values. The frontend must send
    // exactly these params (plus file/api_key/timestamp) and nothing else.
    const paramsToSign = { timestamp, folder, eager };

    const signature = cloudinary.utils.api_sign_request(
      paramsToSign,
      process.env.CLOUDINARY_API_SECRET,
    );

    res.status(200).json({
      signature,
      timestamp,
      apiKey: process.env.CLOUDINARY_API_KEY,
      cloudName: process.env.CLOUDINARY_CLOUD_NAME,
      folder,
      eager,
    });
  } catch (error) {
    console.error("CREATE MESSAGE VIDEO SIGNATURE ERROR:", error.message);
    res.status(500).json({ message: error.message });
  }
};

// SEND VIDEO MESSAGE — called by the custom uploader AFTER the browser has
// uploaded the video directly to Cloudinary (signed via the endpoint above).
// Because the upload response already contains the transformed asset
// (synchronous eager), the message is created fully "ready" in one shot.
// Shares the same permission/block/conversation handling as sendMessage —
// only the media delivery differs.
export const sendVideoMessage = async (req, res) => {
  try {
    const senderId = req.user._id;
    const receiverId = req.params.userId;
    const { text, video } = req.body;

    if (senderId.toString() === receiverId.toString()) {
      return res
        .status(400)
        .json({ message: "Cannot send a message to yourself." });
    }

    const receiver = await User.findById(receiverId).select("name profilePic");
    if (!receiver) {
      return res.status(404).json({ message: "Recipient not found." });
    }

    if (await isBlockedEitherWay(senderId, receiverId)) {
      return res.status(403).json({
        message: "You can't message this user.",
        code: "BLOCKED",
      });
    }

    const permission = await evaluateSendPermission(senderId, receiverId);
    if (!permission.allowed) {
      return res.status(403).json({
        message: permission.reason,
        code: permission.code,
      });
    }

    // Validate the asset belongs to our Cloudinary account and folder —
    // same arbitrary-URL-injection defense as postController.createVideoPost.
    const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
    const allowedPrefix = `https://res.cloudinary.com/${cloudName}/video/upload/`;
    if (
      typeof video?.url !== "string" ||
      !video.url.startsWith(allowedPrefix) ||
      typeof video.publicId !== "string" ||
      !video.publicId.startsWith(`${MESSAGE_VIDEO_FOLDER}/`)
    ) {
      return res.status(400).json({ message: "Invalid video URL" });
    }

    // Thumbnail derivation: Cloudinary can generate a jpg frame from any
    // timestamp via a delivery URL — construct one at the 1-second mark
    // without a second upload/job. The eager MP4 URL carries its
    // transformation segment (/upload/so_0,du_30,f_mp4,...), so that
    // segment must be REPLACED with so_1,f_jpg (see createVideoPost).
    const messageEagerSegment = `/upload/${`so_0,du_${MAX_MESSAGE_VIDEO_DURATION_SECONDS},f_mp4,vc_h264,q_auto`}/`;
    let thumbnailUrl = video.url.replace(
      messageEagerSegment,
      "/upload/so_1,f_jpg/",
    );
    if (!thumbnailUrl.includes("so_1,f_jpg")) {
      // Fallback: raw (non-eager) secure_url — insert after /upload/.
      thumbnailUrl = video.url.replace("/upload/", "/upload/so_1,f_jpg/");
    }
    thumbnailUrl = thumbnailUrl.replace(/\.mp4$/, ".jpg");

    const message = await Message.create({
      sender: senderId,
      receiver: receiverId,
      text: text?.trim() || null,
      video: {
        publicId: video.publicId,
        url: video.url,
        thumbnailUrl,
        durationSeconds: video.durationSeconds || null,
        status: "ready",
      },
      conversationId: getConversationId(senderId, receiverId),
    });

    // Reflect the permission outcome in the Conversation record — identical
    // handling to sendMessage.
    if (permission.isNewRequest) {
      await Conversation.create({
        conversationId: permission.conversationId,
        participants: [senderId, receiverId],
        status: "pending",
        initiator: senderId,
      });
    } else if (permission.implicitAccept) {
      await Conversation.updateOne(
        { conversationId: permission.conversationId },
        { $set: { status: "accepted" } },
      );
    } else if (permission.isMutual && !permission.conversation) {
      // Mutual followers messaging for the first time — record it as
      // accepted so it's unambiguous if they later unfollow each other.
      await Conversation.create({
        conversationId: permission.conversationId,
        participants: [senderId, receiverId],
        status: "accepted",
        initiator: senderId,
      }).catch((err) => {
        // Race: another request created it first — fine, ignore.
        if (err.code !== 11000) throw err;
      });
    }

    const populatedMessage = await message.populate([
      { path: "sender", select: "_id name profilePic" },
      { path: "receiver", select: "_id name profilePic" },
    ]);

    emitToUser(receiverId, "receiveMessage", populatedMessage);

    res.status(201).json(populatedMessage);
  } catch (error) {
    console.error("SEND VIDEO MESSAGE ERROR:", error);
    res.status(500).json({ message: error.message });
  }
};

export const getConversations = async (req, res) => {
  try {
    const currentUserId = req.user._id;

    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(
      Math.max(parseInt(req.query.limit, 10) || 20, 1),
      50,
    );
    const skip = (page - 1) * limit;

    // Do the heavy lifting in Mongo instead of loading full message
    // history into Node memory: group by conversation, keep only the
    // latest message + unread count per conversation, then paginate.
    // $facet runs the paginated page and a total distinct-conversation
    // count in the same aggregation pass, so hasMore is cheap to derive.
    const [result] = await Message.aggregate([
      {
        $match: {
          $or: [{ sender: currentUserId }, { receiver: currentUserId }],
        },
      },
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: "$conversationId",
          lastMessage: {
            $first: {
              $cond: [
                { $eq: ["$text", null] },
                {
                  $cond: [
                    {
                      $ne: [{ $ifNull: ["$video.url", null] }, null],
                    },
                    "🎬 Video",
                    { $cond: [{ $ne: ["$images", []] }, "📷 Photo(s)", ""] },
                  ],
                },
                "$text",
              ],
            },
          },
          lastMessageAt: { $first: "$createdAt" },
          otherUserId: {
            $first: {
              $cond: [
                { $eq: ["$sender", currentUserId] },
                "$receiver",
                "$sender",
              ],
            },
          },
          // Who sent the newest message — so the client can show a
          // "You:" prefix when the preview was written by the user.
          lastMessageSenderId: { $first: "$sender" },
          unreadCount: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ["$receiver", currentUserId] },
                    { $eq: ["$read", false] },
                  ],
                },
                1,
                0,
              ],
            },
          },
        },
      },
      { $sort: { lastMessageAt: -1 } },
      {
        $lookup: {
          from: "conversations",
          localField: "_id",
          foreignField: "conversationId",
          as: "conversationMeta",
        },
      },
      {
        $addFields: {
          conversationMeta: { $arrayElemAt: ["$conversationMeta", 0] },
        },
      },
      {
        // Hide from the main list when it's a request the current user
        // hasn't responded to yet (they see it in Requests instead), or
        // one they declined. Everything else — no Conversation record
        // (legacy/mutual-follow threads), accepted, or a pending request
        // *they* sent — stays visible here.
        $match: {
          $expr: {
            $not: {
              $and: [
                { $ne: ["$conversationMeta", null] },
                {
                  $or: [
                    {
                      $and: [
                        { $eq: ["$conversationMeta.status", "pending"] },
                        { $ne: ["$conversationMeta.initiator", currentUserId] },
                      ],
                    },
                    { $eq: ["$conversationMeta.status", "declined"] },
                  ],
                },
              ],
            },
          },
        },
      },
      {
        $facet: {
          paginatedResults: [
            { $skip: skip },
            { $limit: limit },
            {
              $lookup: {
                from: "users",
                localField: "otherUserId",
                foreignField: "_id",
                as: "otherUser",
              },
            },
            { $unwind: "$otherUser" },
            {
              $project: {
                _id: 0,
                conversationId: "$_id",
                lastMessage: 1,
                lastMessageAt: 1,
                unreadCount: 1,
                // True when the newest message was written by the current
                // user, so the conversation list can show a "You:" prefix.
                lastMessageFromMe: {
                  $eq: ["$lastMessageSenderId", currentUserId],
                },
                requestStatus: {
                  $ifNull: ["$conversationMeta.status", "accepted"],
                },
                otherUser: {
                  _id: "$otherUser._id",
                  name: "$otherUser.name",
                  username: "$otherUser.username",
                  profilePic: "$otherUser.profilePic",
                },
              },
            },
          ],
          totalCount: [{ $count: "count" }],
        },
      },
    ]);

    const conversations = result?.paginatedResults || [];
    const totalConversations = result?.totalCount?.[0]?.count || 0;

    res.status(200).json({
      conversations,
      currentPage: page,
      totalPages: Math.ceil(totalConversations / limit),
      totalConversations,
      hasMore: skip + conversations.length < totalConversations,
    });
  } catch (error) {
    console.error("GET CONVERSATIONS ERROR:", error);
    res.status(500).json({ message: error.message });
  }
};

export const getMessages = async (req, res) => {
  try {
    const currentUserId = req.user._id;
    const otherUserId = req.params.userId;

    if (currentUserId.toString() === otherUserId.toString()) {
      return res
        .status(400)
        .json({ message: "Cannot load conversation with yourself." });
    }

    const conversationId = getConversationId(currentUserId, otherUserId);

    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(
      Math.max(parseInt(req.query.limit, 10) || 30, 1),
      50,
    );
    const skip = (page - 1) * limit;

    // Fetch newest-first so pagination (skip/limit) grabs the most recent
    // page of the thread, then reverse to oldest-first for chat display.
    // Avoids loading the entire message history for long-running chats.
    const totalMessages = await Message.countDocuments({
      conversationId,
      removedAt: null, // moderator soft-takedown — see reportService
    });

    const recentMessages = await Message.find({ conversationId, removedAt: null })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("sender", "_id name profilePic")
      .populate("receiver", "_id name profilePic");

    const messages = recentMessages.reverse();

    const unreadMessages = await Message.updateMany(
      {
        conversationId,
        receiver: currentUserId,
        read: false,
      },
      { read: true },
    );

    if (unreadMessages.modifiedCount > 0) {
      emitToUser(otherUserId, "messagesRead", { conversationId });
      emitToUser(currentUserId, "messagesRead", { conversationId });
    }

    // Tell the frontend whether this thread is a pending request (and
    // from whose side), or blocked, so it can render the right input
    // state (Accept/Decline vs normal composer vs "can't message").
    const [conversation, blocked] = await Promise.all([
      Conversation.findOne({ conversationId }),
      isBlockedEitherWay(currentUserId, otherUserId),
    ]);

    let requestInfo = { status: "accepted", isInitiator: false };
    if (blocked) {
      requestInfo = { status: "blocked", isInitiator: false };
    } else if (conversation) {
      requestInfo = {
        status: conversation.status,
        isInitiator:
          conversation.initiator.toString() === currentUserId.toString(),
      };
    }

    res.status(200).json({
      messages,
      currentPage: page,
      totalPages: Math.ceil(totalMessages / limit),
      hasMore: skip + recentMessages.length < totalMessages,
      requestInfo,
    });
  } catch (error) {
    console.error("GET MESSAGES ERROR:", error);
    res.status(500).json({ message: error.message });
  }
};

export const deleteMessage = async (req, res) => {
  try {
    const currentUserId = req.user._id;
    const messageId = req.params.messageId;

    const message = await Message.findById(messageId);
    if (!message) {
      return res.status(404).json({ message: "Message not found." });
    }

    if (message.sender.toString() !== currentUserId.toString()) {
      return res
        .status(403)
        .json({ message: "Not authorized to delete this message." });
    }

    // Delete the Cloudinary video asset, if any. Best-effort, matching the
    // pattern postController.deletePost uses — an orphaned CDN asset is a
    // cleanup task, not a reason to fail the delete. Message images are
    // intentionally left alone here (consistent with the pre-existing
    // behavior for legacy/multi-image messages).
    if (message.video?.publicId) {
      try {
        await cloudinary.uploader.destroy(message.video.publicId, {
          resource_type: "video",
        });
      } catch (err) {
        console.log("Cloudinary message video delete failed:", err.message);
      }
    }

    await Message.findByIdAndDelete(messageId);

    emitToUser(message.receiver, "messageDeleted", { messageId });

    res.status(200).json({ message: "Message deleted." });
  } catch (error) {
    console.error("DELETE MESSAGE ERROR:", error);
    res.status(500).json({ message: error.message });
  }
};

// GET MESSAGE REQUESTS — pending conversations where the current user is
// the receiver (i.e. they didn't initiate), each with its one message.
export const getMessageRequests = async (req, res) => {
  try {
    const currentUserId = req.user._id;

    const pending = await Conversation.find({
      participants: currentUserId,
      status: "pending",
      initiator: { $ne: currentUserId },
    })
      .populate("participants", "name username profilePic")
      .sort({ createdAt: -1 });

    const requests = await Promise.all(
      pending.map(async (conv) => {
        const otherUser = conv.participants.find(
          (p) => p._id.toString() !== currentUserId.toString(),
        );
        const firstMessage = await Message.findOne({
          conversationId: conv.conversationId,
        }).sort({ createdAt: 1 });

        return {
          conversationId: conv.conversationId,
          otherUser,
          message: firstMessage,
          createdAt: conv.createdAt,
        };
      }),
    );

    res.status(200).json({ requests });
  } catch (error) {
    console.error("GET MESSAGE REQUESTS ERROR:", error);
    res.status(500).json({ message: error.message });
  }
};

// RESPOND TO A MESSAGE REQUEST — accept or decline
export const respondToRequest = async (req, res) => {
  try {
    const currentUserId = req.user._id;
    const otherUserId = req.params.userId;
    const { action } = req.body; // "accept" | "decline"

    if (!["accept", "decline"].includes(action)) {
      return res.status(400).json({ message: "Invalid action." });
    }

    const conversationId = getConversationId(currentUserId, otherUserId);
    const conversation = await Conversation.findOne({ conversationId });

    if (!conversation || conversation.status !== "pending") {
      return res.status(404).json({ message: "No pending request found." });
    }
    if (conversation.initiator.toString() === currentUserId.toString()) {
      return res
        .status(403)
        .json({ message: "You can't respond to your own request." });
    }

    conversation.status = action === "accept" ? "accepted" : "declined";
    await conversation.save();

    if (action === "accept") {
      // Notify the original sender their request was accepted.
      // Decline is intentionally silent — no notification either way.
      emitToUser(otherUserId, "messageRequestAccepted", {
        conversationId,
        by: currentUserId,
      });
    }

    res.status(200).json({ status: conversation.status });
  } catch (error) {
    console.error("RESPOND TO REQUEST ERROR:", error);
    res.status(500).json({ message: error.message });
  }
};
