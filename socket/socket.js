import { Server } from "socket.io";
import http from "http";
import express from "express";
import getAllowedOrigins from "../config/allowedOrigins.js";

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

io.on("connection", (socket) => {
  const userId = socket.handshake.query.userId;

  if (userId && userId !== "undefined") {
    if (!userSocketMap.has(userId)) {
      userSocketMap.set(userId, new Set());
    }
    userSocketMap.get(userId).add(socket.id);
    broadcastOnlineUsers();
  }

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
    if (userId && userId !== "undefined") {
      const socketIds = userSocketMap.get(userId);
      if (socketIds) {
        socketIds.delete(socket.id);
        if (socketIds.size === 0) {
          userSocketMap.delete(userId);
          broadcastOnlineUsers();
        }
      }
    }
  });
});

export { app, io, server };
