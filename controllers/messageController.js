import Message from "../models/Message.js";
import User from "../models/User.js";
import cloudinary from "../utils/cloudinary.js";
import { emitToUser } from "../socket/socket.js";

const getConversationId = (userA, userB) => {
  const participants = [userA.toString(), userB.toString()].sort();
  return `${participants[0]}_${participants[1]}`;
};

export const sendMessage = async (req, res) => {
  try {
    const senderId = req.user._id;
    const receiverId = req.params.userId;
    const { text } = req.body;

    if ((!text || !text.trim()) && !req.file) {
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

    let imageUrl = null;

    // Upload image to Cloudinary if provided
    if (req.file) {
      try {
        const b64 = `data:${req.file.mimetype};base64,${req.file.buffer.toString("base64")}`;
        const result = await cloudinary.uploader.upload(b64, {
          folder: "tronites_messages",
        });
        imageUrl = result.secure_url;
      } catch (uploadError) {
        console.error("Image upload to Cloudinary failed:", uploadError);
        return res.status(500).json({ message: "Image upload failed." });
      }
    }

    const message = await Message.create({
      sender: senderId,
      receiver: receiverId,
      text: text?.trim() || null,
      image: imageUrl,
      conversationId: getConversationId(senderId, receiverId),
    });

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
          lastMessage: { $first: "$text" },
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
                otherUser: {
                  _id: "$otherUser._id",
                  name: "$otherUser.name",
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
    const totalMessages = await Message.countDocuments({ conversationId });

    const recentMessages = await Message.find({ conversationId })
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

    res.status(200).json({
      messages,
      currentPage: page,
      totalPages: Math.ceil(totalMessages / limit),
      hasMore: skip + recentMessages.length < totalMessages,
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

    await Message.findByIdAndDelete(messageId);

    emitToUser(message.receiver, "messageDeleted", { messageId });

    res.status(200).json({ message: "Message deleted." });
  } catch (error) {
    console.error("DELETE MESSAGE ERROR:", error);
    res.status(500).json({ message: error.message });
  }
};
