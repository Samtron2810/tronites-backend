import { Server } from "socket.io";
import http from "http";
import express from "express";
import jwt from "jsonwebtoken";
import cookie from "cookie";
import getAllowedOrigins from "../config/allowedOrigins.js";
import User from "../models/User.js";

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: getAllowedOrigins(),
    credentials: true,
    methods: ["GET", "POST"],
  },
  transports: ["websocket"],
});

const userSocketMap = new Map(); // Map<string, Set<string>>

export const getReceiverSocketIds = (receiverId) => {
  if (!receiverId) return [];
  const socketIds = userSocketMap.get(receiverId.toString());
  return socketIds ? Array.from(socketIds) : [];
};

const getOnlineUsers = () => Array.from(userSocketMap.keys());

const broadcastOnlineUsers = () => {
  io.emit("getOnlineUsers", getOnlineUsers());
};

// Authenticate every socket connection using the same JWT cookie
// the REST API uses. Never trust a client-supplied userId.
io.use(async (socket, next) => {
  try {
    const rawCookie = socket.handshake.headers.cookie;

    if (!rawCookie) {
      return next(new Error("Not authorized, no token"));
    }

    const parsedCookies = cookie.parse(rawCookie);
    const token = parsedCookies.token;

    if (!token) {
      return next(new Error("Not authorized, no token"));
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.userId).select("_id");

    if (!user) {
      return next(new Error("Not authorized, user no longer exists"));
    }

    // Trusted, server-derived identity — attached to the socket
    socket.userId = user._id.toString();
    next();
  } catch (error) {
    next(new Error("Not authorized, token failed"));
  }
});

io.on("connection", (socket) => {
  const userId = socket.userId;

  if (!userSocketMap.has(userId)) {
    userSocketMap.set(userId, new Set());
  }
  userSocketMap.get(userId).add(socket.id);
  broadcastOnlineUsers();

  // Join a post room for real-time like/comment updates
  socket.on("joinPost", (postId) => {
    if (postId) {
      socket.join(`post_${postId}`);
    }
  });

  // Leave a post room
  socket.on("leavePost", (postId) => {
    if (postId) {
      socket.leave(`post_${postId}`);
    }
  });

  // Join conversation room for real-time read status
  socket.on("joinConversation", (conversationId) => {
    if (conversationId) {
      socket.join(`conversation_${conversationId}`);
    }
  });

  // Leave conversation room
  socket.on("leaveConversation", (conversationId) => {
    if (conversationId) {
      socket.leave(`conversation_${conversationId}`);
    }
  });

  socket.on("disconnect", () => {
    const socketIds = userSocketMap.get(userId);
    if (socketIds) {
      socketIds.delete(socket.id);
      if (socketIds.size === 0) {
        userSocketMap.delete(userId);
        broadcastOnlineUsers();
      }
    }
  });
});

export { app, io, server };
