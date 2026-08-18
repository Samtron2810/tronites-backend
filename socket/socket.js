import { Server } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import { createClient } from "redis";
import http from "http";
import express from "express";
import jwt from "jsonwebtoken";
import cookie from "cookie";
import getAllowedOrigins from "../config/allowedOrigins.js";
import User from "../models/User.js";
import { isFollowing } from "../services/followService.js";
import { getBlockedEitherWayIds } from "../services/blockService.js";

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: getAllowedOrigins(),
    credentials: true,
    methods: ["GET", "POST"],
  },
  // Not forcing transports to ["websocket"] here: that removes Socket.IO's
  // normal polling-first-then-upgrade handshake, which is more resilient
  // to proxies/load balancers that don't cleanly support an immediate
  // WebSocket upgrade. Left at the library default (polling + websocket).
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

let redisAdapterReady = false;
let adapterAttached = false;

// Wires the Redis adapter onto the io server. Idempotent, so it's safe to
// call both from a successful boot-time connect and from a later
// background reconnect without attaching it twice.
const attachAdapter = () => {
  if (adapterAttached) return;
  io.adapter(createAdapter(pubClient, subClient));
  adapterAttached = true;
};

// Registered unconditionally — not just inside a successful boot connect —
// so that if Redis is unreachable at startup, a *later* successful connect
// (the client's own reconnect strategy keeps retrying in the background)
// still upgrades this instance to the Redis adapter and rebuilds presence,
// with no restart required.
pubClient.on("error", (err) => {
  console.error("Redis (socket pub) error:", err.message);
  redisAdapterReady = false;
});
subClient.on("error", (err) => {
  console.error("Redis (socket sub) error:", err.message);
});
pubClient.on("ready", () => {
  redisAdapterReady = true;
  attachAdapter();
  // Redis was down (or this is the first connect) — either way,
  // reconcile the shared presence hash with what this instance actually
  // has connected, so an outage doesn't erase real users.
  rebuildPresenceFromLocalState();
});

// How long to wait for the initial pub/sub connect before falling back to
// single-instance, in-memory mode. Needed because the client's default
// reconnectStrategy retries forever and never rejects on its own —
// verified empirically that an unbounded await here hangs forever when
// Redis is unreachable, which would stop the server from ever starting.
// The connection keeps retrying in the background after this timeout, so
// the 'ready' listener above still fires — and the adapter attaches
// automatically — the moment Redis becomes reachable.
const ADAPTER_CONNECT_TIMEOUT_MS =
  Number(process.env.REDIS_CONNECT_TIMEOUT_MS) || 5000;

export const initSocketRedisAdapter = async () => {
  try {
    await Promise.race([
      Promise.all([pubClient.connect(), subClient.connect()]),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error(`timed out after ${ADAPTER_CONNECT_TIMEOUT_MS}ms`)),
          ADAPTER_CONNECT_TIMEOUT_MS,
        ),
      ),
    ]);
    attachAdapter();
    redisAdapterReady = true;
    console.log(
      "Socket.IO Redis adapter connected — horizontal scaling enabled",
    );
  } catch (err) {
    console.warn(
      "Socket.IO Redis adapter did not connect at startup — running single-instance, in-memory presence mode for now. It will upgrade automatically once Redis is reachable:",
      err.message,
    );
  }
};

// Live status for the readiness health check.
export const isSocketAdapterReady = () => redisAdapterReady;

// Graceful-shutdown counterpart to initSocketRedisAdapter(). Also clears
// the presence sweep interval below — left running, it fires forever on
// its own 15s timer and, once the clients are closed, logs a "client is
// closed" error on every tick instead of stopping cleanly.
export const disconnectSocketRedis = async () => {
  clearInterval(presenceSweepInterval);
  await Promise.allSettled([
    pubClient.isOpen ? pubClient.quit() : Promise.resolve(),
    subClient.isOpen ? subClient.quit() : Promise.resolve(),
  ]);
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

// Reads global presence from Redis (all instances) when available, falls
// back to this instance's local map if Redis is down. Gated on
// redisAdapterReady alone — that flag already tracks pubClient's own
// connection state via its 'ready'/'error' listeners above, so it's the
// correct signal here. It used to also require the separate, unrelated
// caching redisClient (utils/redis.js) to be ready, which meant a hiccup
// on that entirely different connection could make presence fall back to
// local-only even while pubClient itself was perfectly healthy.
const getOnlineUserIds = async () => {
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

// Small in-process cache for presenceVisibility lookups — this is read
// on every presence broadcast for every online user, which without
// caching would mean N extra Mongo reads (N = online user count) on
// every single connect/disconnect anywhere on the platform. Visibility
// preference changes rarely and isn't safety-critical to propagate
// instantly (worst case, a user who just tightened their setting stays
// visible to already-computed viewer lists for a few seconds), so a
// short TTL is the right tradeoff over hitting Mongo every time.
const presenceVisibilityCache = new Map(); // userId -> { value, expiresAt }
const PRESENCE_VISIBILITY_CACHE_MS = 10000;

const getPresenceVisibility = async (userId) => {
  const cached = presenceVisibilityCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const user = await User.findById(userId).select("presenceVisibility").lean();
  const value = user?.presenceVisibility || "everyone";
  presenceVisibilityCache.set(userId, { value, expiresAt: Date.now() + PRESENCE_VISIBILITY_CACHE_MS });
  return value;
};

// Builds the online-user list a SPECIFIC viewer is allowed to see. This
// replaced a single global io.emit() that sent every online userId to
// every connected socket regardless of relationship — meaning a blocked
// user, a total stranger, or anyone at all could see exactly who on the
// platform was currently online. Now each online candidate is checked
// against the viewer's relationship to them:
//   - "everyone": visible to any authenticated viewer (except a block
//     either direction, which always wins over any visibility setting)
//   - "followers": visible only if the candidate follows the viewer back
//     (i.e. it's a connection from the candidate's side, not just "the
//     viewer happens to follow them")
//   - "nobody": never included, full stop
const buildVisibleOnlineList = async (viewerId, onlineIds) => {
  const candidates = onlineIds.filter((id) => id !== viewerId);
  if (candidates.length === 0) return [viewerId].filter((id) => onlineIds.includes(id));

  const blockedIds = await getBlockedEitherWayIds(viewerId);

  const visible = [];
  for (const candidateId of candidates) {
    if (blockedIds.has(candidateId)) continue;

    const visibility = await getPresenceVisibility(candidateId);
    if (visibility === "nobody") continue;
    if (visibility === "everyone") {
      visible.push(candidateId);
      continue;
    }
    // "followers": only show if the candidate follows the viewer —
    // i.e. isFollowing(candidateId, viewerId) is true.
    // eslint-disable-next-line no-await-in-loop
    const candidateFollowsViewer = await isFollowing(candidateId, viewerId);
    if (candidateFollowsViewer) visible.push(candidateId);
  }

  // Always include the viewer's own presence in their own list —
  // clients use this to reflect their own online dot too.
  if (onlineIds.includes(viewerId)) visible.push(viewerId);

  return visible;
};

// Broadcasting is now per-user instead of one global io.emit() — each
// online user gets their own filtered list emitted to just their room.
// Debounced the same way the old global broadcast was: connect/
// disconnect storms collapse into one recompute-and-fan-out pass per
// 300ms window instead of one per individual state change.
let broadcastPending = false;
const broadcastOnlineUsers = () => {
  if (broadcastPending) return;
  broadcastPending = true;
  setTimeout(async () => {
    broadcastPending = false;
    const onlineIds = await getOnlineUserIds();
    // Fan out to every currently-online user's room with a list built
    // just for them. This is O(online users) filtering work per
    // broadcast instead of O(1) — a deliberate tradeoff: presence
    // privacy requires per-viewer computation, there's no way to
    // compute one list that's simultaneously correct for every viewer's
    // different visibility/block relationships.
    await Promise.all(
      onlineIds.map(async (viewerId) => {
        const visible = await buildVisibleOnlineList(viewerId, onlineIds);
        io.to(`user_${viewerId}`).emit("getOnlineUsers", visible);
      }),
    );
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
  if (!redisAdapterReady) return;
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
  if (!redisAdapterReady) return;
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
  if (!redisAdapterReady) return;
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
  if (!redisAdapterReady) return;
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

const presenceSweepInterval = setInterval(sweepStalePresence, PRESENCE_SWEEP_INTERVAL_MS);

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
    const onlineIds = await getOnlineUserIds();
    const visible = await buildVisibleOnlineList(userId, onlineIds);
    socket.emit("getOnlineUsers", visible);
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
