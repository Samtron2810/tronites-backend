import Message from "../models/Message.js";
import User from "../models/User.js";
import cloudinary from "../utils/cloudinary.js";
import { io, getReceiverSocketIds } from "../socket/socket.js";

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

    const recipientSockets = getReceiverSocketIds(receiverId);
    recipientSockets.forEach((socketId) => {
      io.to(socketId).emit("receiveMessage", populatedMessage);
    });

    res.status(201).json(populatedMessage);
  } catch (error) {
    console.error("SEND MESSAGE ERROR:", error);
    res.status(500).json({ message: error.message });
  }
};

export const getConversations = async (req, res) => {
  try {
    const currentUserId = req.user._id;
    const messages = await Message.find({
      $or: [{ sender: currentUserId }, { receiver: currentUserId }],
    })
      .sort({ createdAt: -1 })
      .populate("sender", "_id name profilePic")
      .populate("receiver", "_id name profilePic");

    const conversationsMap = new Map();

    messages.forEach((message) => {
      if (!conversationsMap.has(message.conversationId)) {
        const otherUser =
          message.sender._id.toString() === currentUserId.toString()
            ? message.receiver
            : message.sender;

        conversationsMap.set(message.conversationId, {
          conversationId: message.conversationId,
          otherUser,
          lastMessage: message.text,
          lastMessageAt: message.createdAt,
          unreadCount:
            message.receiver._id.toString() === currentUserId.toString() &&
            !message.read
              ? 1
              : 0,
        });
      } else {
        const conversation = conversationsMap.get(message.conversationId);
        if (
          message.receiver._id.toString() === currentUserId.toString() &&
          !message.read
        ) {
          conversation.unreadCount += 1;
        }
      }
    });

    const conversations = Array.from(conversationsMap.values());

    res.status(200).json(conversations);
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

    const messages = await Message.find({ conversationId })
      .sort({ createdAt: 1 })
      .populate("sender", "_id name profilePic")
      .populate("receiver", "_id name profilePic");

    const unreadMessages = await Message.updateMany(
      {
        conversationId,
        receiver: currentUserId,
        read: false,
      },
      { read: true },
    );

    if (unreadMessages.modifiedCount > 0) {
      const senderSockets = getReceiverSocketIds(otherUserId);
      senderSockets.forEach((socketId) => {
        io.to(socketId).emit("messagesRead", { conversationId });
      });
    }

    res.status(200).json(messages);
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

    const recipientSockets = getReceiverSocketIds(message.receiver);
    recipientSockets.forEach((socketId) => {
      io.to(socketId).emit("messageDeleted", { messageId });
    });

    res.status(200).json({ message: "Message deleted." });
  } catch (error) {
    console.error("DELETE MESSAGE ERROR:", error);
    res.status(500).json({ message: error.message });
  }
};
