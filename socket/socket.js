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
import { isRedisReady } from "../utils/redis.js";

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
    console.log(
      "Socket.IO Redis adapter connected — horizontal scaling enabled",
    );

    // If Redis drops later (not just at boot), fall back to the local
    // in-memory presence map instead of continuing to read a hash that's
    // no longer reachable.
    pubClient.on("error", () => {
      redisAdapterReady = false;
    });
    pubClient.on("ready", () => {
      redisAdapterReady = true;
      // Redis was down (or this is the first connect) — either way,
      // reconcile the shared presence hash with what this instance
      // actually has connected, so an outage doesn't erase real users.
      rebuildPresenceFromLocalState();
    });
  } catch (err) {
    console.warn(
      "Socket.IO Redis adapter failed to connect — running single-instance, in-memory presence mode:",
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
// Sorted set: userId -> last heartbeat timestamp (ms). Used to age out
// entries that never got a clean disconnect (crash, killed instance,
// network black hole) — see sweepStalePresence() below.
const PRESENCE_HEARTBEAT_KEY = "presence:heartbeat";
// A connected client is expected to touch its heartbeat at least this
// often (see the per-socket interval below). Anything older than this
// when the sweep runs is considered dead.
const PRESENCE_STALE_MS = 30000;
const PRESENCE_SWEEP_INTERVAL_MS = 15000;

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
// falls back to this instance's local map if Redis is down. Checks
// isRedisReady() too (not just redisAdapterReady) so a Redis outage that
// happens after a successful boot connect still degrades correctly.
const getOnlineUsers = async () => {
  if (redisAdapterReady && isRedisReady()) {
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
//
// Both use a Lua script so the count mutation, the heartbeat timestamp,
// and (on decrement) the cleanup delete happen as one atomic operation.
// Without this, a fast disconnect+reconnect (e.g. a network blip) can
// interleave as: old socket reads count->0, new socket increments to 1,
// old socket's now-stale "count was <=1" check deletes the entry the new
// socket just created — user is online but shows offline. See decrement
// script below for the exact sequence this closes.
const INCREMENT_SCRIPT = `
  local count = redis.call('HINCRBY', KEYS[1], ARGV[1], 1)
  redis.call('ZADD', KEYS[2], ARGV[2], ARGV[1])
  return count
`;

// Atomically decrements the count and deletes the hash entry only if the
// decrement (not a later, possibly stale read) brought it to <= 0. Doing
// the HINCRBY and the conditional HDEL in one EVAL means no other client
// can run an increment in between — closing the reconnect race described
// above.
const DECREMENT_SCRIPT = `
  local count = redis.call('HINCRBY', KEYS[1], ARGV[1], -1)
  if count <= 0 then
    redis.call('HDEL', KEYS[1], ARGV[1])
    redis.call('ZREM', KEYS[2], ARGV[1])
  else
    redis.call('ZADD', KEYS[2], ARGV[2], ARGV[1])
  end
  return count
`;

const incrementPresence = async (userId) => {
  if (!redisAdapterReady || !isRedisReady()) return;
  try {
    await pubClient.eval(INCREMENT_SCRIPT, {
      keys: [PRESENCE_KEY, PRESENCE_HEARTBEAT_KEY],
      arguments: [userId, Date.now().toString()],
    });
  } catch (err) {
    console.error("Presence increment failed:", err.message);
  }
};

const decrementPresence = async (userId) => {
  if (!redisAdapterReady || !isRedisReady()) return;
  try {
    await pubClient.eval(DECREMENT_SCRIPT, {
      keys: [PRESENCE_KEY, PRESENCE_HEARTBEAT_KEY],
      arguments: [userId, Date.now().toString()],
    });
  } catch (err) {
    console.error("Presence decrement failed:", err.message);
  }
};

// Refreshes just the heartbeat timestamp for a user without touching the
// socket count. Called on a timer for every connected socket so the
// sweep below can tell "still connected, server just hasn't heard a
// disconnect yet" apart from "actually dead".
const touchPresenceHeartbeat = async (userId) => {
  if (!redisAdapterReady || !isRedisReady()) return;
  try {
    await pubClient.zAdd(PRESENCE_HEARTBEAT_KEY, {
      score: Date.now(),
      value: userId,
    });
  } catch (err) {
    console.error("Presence heartbeat failed:", err.message);
  }
};

// Removes presence entries whose heartbeat is older than PRESENCE_STALE_MS.
// This is what actually fixes "online when offline": a crashed instance,
// a socket that dies without emitting "disconnect", or a Redis write that
// silently failed all leave a userId in PRESENCE_KEY forever otherwise.
// PRESENCE_TTL_FALLBACK_MS used to be declared for this purpose and never
// wired up — this is that wiring.
const sweepStalePresence = async () => {
  if (!redisAdapterReady || !isRedisReady()) return;
  try {
    const cutoff = Date.now() - PRESENCE_STALE_MS;
    const staleUserIds = await pubClient.zRangeByScore(
      PRESENCE_HEARTBEAT_KEY,
      0,
      cutoff,
    );
    if (staleUserIds.length === 0) return;

    for (const userId of staleUserIds) {
      await pubClient.hDel(PRESENCE_KEY, userId);
      await pubClient.zRem(PRESENCE_HEARTBEAT_KEY, userId);
    }
    console.log(
      `Presence sweep: removed ${staleUserIds.length} stale entr${staleUserIds.length === 1 ? "y" : "ies"}`,
    );
    broadcastOnlineUsers();
  } catch (err) {
    console.error("Presence sweep failed:", err.message);
  }
};

setInterval(sweepStalePresence, PRESENCE_SWEEP_INTERVAL_MS);

// When Redis goes down, increment/decrement calls above no-op (no writes),
// so PRESENCE_KEY is missing all activity from the outage. When Redis
// comes back, reading it directly would show everyone as offline even
// though userSocketMap (this instance's local truth) says otherwise.
// Rebuild PRESENCE_KEY from userSocketMap the moment Redis becomes ready
// again so genuinely-connected users don't vanish from presence.
const rebuildPresenceFromLocalState = async () => {
  if (userSocketMap.size === 0) return;
  try {
    for (const [userId, socketIds] of userSocketMap.entries()) {
      if (socketIds.size === 0) continue;
      await pubClient.hSet(PRESENCE_KEY, userId, socketIds.size);
      await pubClient.zAdd(PRESENCE_HEARTBEAT_KEY, {
        score: Date.now(),
        value: userId,
      });
    }
    console.log(
      `Presence rebuilt from local state for ${userSocketMap.size} user(s) after Redis reconnect`,
    );
    broadcastOnlineUsers();
  } catch (err) {
    console.error("Presence rebuild failed:", err.message);
  }
};

io.on("connection", (socket) => {
  const userId = socket.userId;

  if (!userSocketMap.has(userId)) {
    userSocketMap.set(userId, new Set());
  }
  userSocketMap.get(userId).add(socket.id);

  // Awaited (not fire-and-forget) so the debounced broadcast that follows
  // always reads a presence hash that already reflects this connect —
  // otherwise a slow Redis round-trip can race the 300ms broadcast timer
  // and emit a stale list that's missing the user who just connected.
  (async () => {
    await incrementPresence(userId);
    broadcastOnlineUsers();
  })();

  // Periodic heartbeat while this socket is open. This is what lets
  // sweepStalePresence() tell "still connected" apart from "server died
  // without a clean disconnect" — a crash simply stops refreshing the
  // timestamp, and the sweep ages the entry out within PRESENCE_STALE_MS.
  const heartbeatInterval = setInterval(() => {
    touchPresenceHeartbeat(userId);
  }, PRESENCE_SWEEP_INTERVAL_MS);

  // Self-heal: lets the client explicitly re-sync if it suspects it
  // missed a broadcast (e.g. right after its own reconnect), instead of
  // waiting on some other user's connect/disconnect to trigger the next one.
  socket.on("getOnlineUsers:request", async () => {
    socket.emit("getOnlineUsers", await getOnlineUsers());
  });

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

  socket.on("disconnect", async () => {
    clearInterval(heartbeatInterval);

    const socketIds = userSocketMap.get(userId);
    if (socketIds) {
      socketIds.delete(socket.id);
      if (socketIds.size === 0) {
        userSocketMap.delete(userId);
      }
    }
    // Awaited for the same reason as the connect path above — the
    // broadcast must see the decrement, not race ahead of it.
    await decrementPresence(userId);
    broadcastOnlineUsers();
  });
});

export { app, io, server };
