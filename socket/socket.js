import { Server } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import { createClient } from "redis";
import http from "http";
import express from "express";
import jwt from "jsonwebtoken";
import cookie from "cookie";
import getAllowedOrigins from "../config/allowedOrigins.js";
import User from "../models/User.js";
import { listFollowingIds } from "../services/followService.js";

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

// --- Redis adapter: makes Socket.IO horizontally scalable ---
// Without this, userSocketMap only knows about sockets on THIS process.
// Run 3 instances behind a load balancer and a socket on instance A can
// never reach a socket on instance B — io.to(socketId).emit() silently
// does nothing cross-instance. The adapter uses Redis pub/sub so every
// instance broadcasts through Redis and all instances receive it.
//
// Needs its own dedicated pub/sub connections — cannot reuse the caching
// redisClient from utils/redis.js, because a client in subscriber mode
// can't run normal GET/SET commands.
const pubClient = createClient({
  url: process.env.REDIS_URL || "redis://localhost:6379",
});
const subClient = pubClient.duplicate();

pubClient.on("error", (err) => console.error("Redis (socket pub) error:", err));
subClient.on("error", (err) => console.error("Redis (socket sub) error:", err));

let redisAdapterReady = false;

export const initSocketRedisAdapter = async () => {
  try {
    await Promise.all([pubClient.connect(), subClient.connect()]);
    io.adapter(createAdapter(pubClient, subClient));
    redisAdapterReady = true;
    console.log("Socket.IO Redis adapter connected — horizontal scaling enabled");
  } catch (err) {
    console.warn(
      "Socket.IO Redis adapter failed to connect — falling back to single-instance in-memory mode:",
      err.message,
    );
  }
};

// --- Online-user presence ---
// userSocketMap only holds sockets connected to THIS process. That's fine
// for per-instance bookkeeping (disconnect cleanup, direct emits via
// getReceiverSocketIds), but presence ("who is online") must be tracked
// in Redis so it's correct across all instances, not just this one.
const userSocketMap = new Map(); // Map<string, Set<string>>

const PRESENCE_KEY = "presence:online_users"; // Redis hash: userId -> socket count
const PRESENCE_TTL_FALLBACK_MS = 5000; // debounce window for broadcast storms

export const getReceiverSocketIds = (receiverId) => {
  if (!receiverId) return [];
  const socketIds = userSocketMap.get(receiverId.toString());
  return socketIds ? Array.from(socketIds) : [];
};

// Preferred way to send a direct event to a specific user: emits to their
// room once instead of looking up individual socket IDs and looping.
// Works correctly across multiple server instances via the Redis adapter.
export const emitToUser = (userId, event, payload) => {
  if (!userId) return;
  io.to(`user_${userId.toString()}`).emit(event, payload);
};

// --- Followers room: O(1) fan-out for "new post" events ---
// Without this, notifying followers of a new post means looping over
// every follower and emitting individually — O(followers) work every
// single time anyone posts. Instead, each author has one room
// (`followers_of_<authorId>`), and every socket that follows that author
// joins it once, on connect. Posting then costs a single
// io.to(`followers_of_<authorId>`).emit(...) — O(1) regardless of
// follower count.
//
// The cost moves to connect time instead: a user with many "following"
// joins many rooms when they connect. That's still O(following), but
// connects happen far less often than posts for an active social feed,
// so this is the right place to pay that cost.
export const emitToFollowersOf = (authorId, event, payload) => {
  if (!authorId) return;
  io.to(`followers_of_${authorId.toString()}`).emit(event, payload);
};

// Called after follow/unfollow so a currently-connected socket's room
// membership stays in sync without requiring a reconnect.
export const joinFollowersRoom = (socketOrUserId, followingId) => {
  if (!followingId) return;
  const room = `followers_of_${followingId.toString()}`;
  if (typeof socketOrUserId === "string") {
    // Join every open socket for this user across this instance. With
    // the Redis adapter, io.in(...) can target rooms cross-instance, but
    // joining requires the actual socket object, so we look up local
    // sockets by user id room and join them to the new room.
    io.in(`user_${socketOrUserId}`).socketsJoin(room);
  } else {
    socketOrUserId.join(room);
  }
};

export const leaveFollowersRoom = (socketOrUserId, followingId) => {
  if (!followingId) return;
  const room = `followers_of_${followingId.toString()}`;
  if (typeof socketOrUserId === "string") {
    io.in(`user_${socketOrUserId}`).socketsLeave(room);
  } else {
    socketOrUserId.leave(room);
  }
};

// Reads global presence from Redis (all instances) when available,
// falls back to this instance's local map if Redis is down.
const getOnlineUsers = async () => {
  if (redisAdapterReady) {
    try {
      const ids = await pubClient.hKeys(PRESENCE_KEY);
      return ids;
    } catch {
      // fall through to local map
    }
  }
  return Array.from(userSocketMap.keys());
};

// Debounced broadcast: connect/disconnect storms (e.g. mass reconnect after
// a deploy) used to trigger one io.emit() per event — O(N) emits for N
// state changes, each one O(N) to fan out = O(N^2) total. Collapsing
// bursts into a single broadcast per 300ms window fixes that.
let broadcastPending = false;
const broadcastOnlineUsers = () => {
  if (broadcastPending) return;
  broadcastPending = true;
  setTimeout(async () => {
    broadcastPending = false;
    io.emit("getOnlineUsers", await getOnlineUsers());
  }, 300);
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

// Increment/decrement a per-user socket count in the shared Redis presence
// hash. Using counts (not just add/remove from a set) means a user with
// two tabs open only disappears from "online" when BOTH disconnect.
const incrementPresence = async (userId) => {
  if (!redisAdapterReady) return;
  try {
    const count = await pubClient.hIncrBy(PRESENCE_KEY, userId, 1);
    if (count === 1) {
      // first socket for this user across all instances — no-op here,
      // getOnlineUsers() already reflects it via hKeys
    }
  } catch (err) {
    console.error("Presence increment failed:", err.message);
  }
};

const decrementPresence = async (userId) => {
  if (!redisAdapterReady) return;
  try {
    const count = await pubClient.hIncrBy(PRESENCE_KEY, userId, -1);
    if (count <= 0) {
      await pubClient.hDel(PRESENCE_KEY, userId);
    }
  } catch (err) {
    console.error("Presence decrement failed:", err.message);
  }
};

io.on("connection", (socket) => {
  const userId = socket.userId;

  if (!userSocketMap.has(userId)) {
    userSocketMap.set(userId, new Set());
  }
  userSocketMap.get(userId).add(socket.id);
  incrementPresence(userId);
  broadcastOnlineUsers();

  // Every socket for this user joins their personal room. This replaces
  // per-socket-ID emits (io.to(socketId).emit(...) for each entry in
  // getReceiverSocketIds()) with a single io.to(`user_${userId}`).emit(...).
  // Two wins: (1) with the Redis adapter, a room-based emit reaches
  // sockets on ANY server instance automatically — no per-instance socket
  // map lookup needed; (2) a burst of emits to many different users (e.g.
  // notifying every follower of a new post) becomes N room emits instead
  // of N *and* an in-memory Map lookup + Set-to-Array conversion for each.
  socket.join(`user_${userId}`);

  // Join a "followers_of_<X>" room for every user this socket's owner
  // follows, so new-post events can be a single room emit instead of a
  // per-follower loop. Runs once per connect, not per post — the cost is
  // paid here instead of at post-creation time.
  (async () => {
    try {
      const followingIds = await listFollowingIds(userId);
      followingIds.forEach((id) => socket.join(`followers_of_${id}`));
    } catch (err) {
      console.error("Failed to join followers rooms on connect:", err.message);
    }
  })();

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
      }
    }
    decrementPresence(userId);
    broadcastOnlineUsers();
  });
});

export { app, io, server };
