import { createClient } from "redis";

const redisClient = createClient({
  url: process.env.REDIS_URL || "redis://localhost:6379",
});

let redisReady = false;

redisClient.on("connect", () => {
  console.log("Redis connecting...");
});

redisClient.on("ready", () => {
  redisReady = true;
  console.log("Redis ready");
});

redisClient.on("error", (err) => {
  redisReady = false;
  console.error("Redis Client Error:", err.message);
});

redisClient.on("end", () => {
  redisReady = false;
  console.warn("Redis connection closed");
});

export const isRedisReady = () => {
  return redisReady && redisClient.isReady;
};

// How long to wait for the *initial* connect before giving up and letting
// the server boot without Redis. The client's default reconnectStrategy
// retries forever and never rejects on its own — verified empirically
// that an unbounded `await redisClient.connect()` hangs indefinitely when
// Redis is unreachable, which would stop the server from ever starting.
// The connection keeps retrying in the background after this timeout, so
// the 'ready' listener above still fires — and redisReady flips back to
// true automatically, with no restart needed — the moment Redis is
// actually reachable.
const CONNECT_TIMEOUT_MS = Number(process.env.REDIS_CONNECT_TIMEOUT_MS) || 5000;

export const connectRedis = async () => {
  if (redisClient.isOpen) {
    return;
  }

  try {
    await Promise.race([
      redisClient.connect(),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error(`timed out after ${CONNECT_TIMEOUT_MS}ms`)),
          CONNECT_TIMEOUT_MS,
        ),
      ),
    ]);
  } catch (err) {
    redisReady = false;

    console.warn(
      "Redis did not connect at startup — continuing without Redis (caching, shared rate limiting, and the image-upload queue will run in fallback mode). It will connect automatically once reachable:",
      err.message,
    );
  }
};

// Graceful-shutdown counterpart to connectRedis(). Safe to call even if
// Redis never connected.
export const disconnectRedis = async () => {
  if (!redisClient.isOpen) return;
  try {
    await redisClient.quit();
  } catch (err) {
    console.warn("Redis client did not quit cleanly:", err.message);
  }
};

// Helper: get or set cache
export const getOrSetCache = async (key, fetchFn, ttl = 180) => {
  try {
    const cached = await redisClient.get(key);
    if (cached) {
      return JSON.parse(cached);
    }
  } catch {
    // Redis down — fall through
  }

  const data = await fetchFn();

  try {
    await redisClient.setEx(key, ttl, JSON.stringify(data));
  } catch {
    // Redis down — skip cache write
  }

  return data;
};

// Helper: delete cache keys matching a pattern
// Uses SCAN (cursor-based, non-blocking) instead of KEYS, which blocks
// the whole Redis event loop while it walks the entire keyspace — that
// gets slower as the dataset grows and stalls every other client mid-scan.
export const invalidateCache = async (pattern) => {
  try {
    const keysToDelete = [];

    // redis@6's scanIterator yields one BATCH (array of keys) per
    // iteration, not a single key at a time — confirmed against the
    // client's own source (`yield reply.keys`). Spreading each batch is
    // required; pushing the batch array itself would silently produce a
    // nested array that del() can't match against real key names.
    for await (const batch of redisClient.scanIterator({
      MATCH: pattern,
      COUNT: 100,
    })) {
      keysToDelete.push(...batch);
      // Delete in small batches so we don't build one giant DEL command
      // for patterns that match a huge number of keys.
      if (keysToDelete.length >= 500) {
        await redisClient.del(keysToDelete.splice(0, keysToDelete.length));
      }
    }

    if (keysToDelete.length > 0) {
      await redisClient.del(keysToDelete);
    }
  } catch {
    // Redis down — skip
  }
};

// Helper: delete a single cache key
export const deleteCacheKey = async (key) => {
  try {
    await redisClient.del(key);
  } catch {
    // Redis down — skip
  }
};

// --- Versioned feed cache ---
//
// invalidateCache(`feed:${userId}:*`) used SCAN to find and delete every
// paginated feed key for a user. SCAN is non-blocking (unlike KEYS), but
// it's still an O(keyspace) walk that runs on every single like/post/mute
// change — for a user with many cached feed pages, or a busy keyspace,
// that's a lot of avoidable work for what is fundamentally a "throw away
// old data" operation.
//
// A version counter makes invalidation O(1): bump the counter, and every
// previously-cached `feed:v{oldVersion}:...` key is simply never read
// again (it expires naturally via its own TTL — no explicit delete
// needed). Reads always ask for the *current* version's key.
const getFeedVersion = async (userId) => {
  try {
    const v = await redisClient.get(`feedVersion:${userId}`);
    return v ? Number(v) : 1;
  } catch {
    // Redis down — every caller gets the same fallback version, which is
    // fine: without Redis, getOrSetCache's own get/set calls no-op too,
    // so this key is never actually written or read from cache anyway.
    return 1;
  }
};

// `pageKey` is either a page number (legacy) or a cursor id / "start" —
// it's just an opaque string differentiating cache entries, the function
// doesn't care what it represents.
export const getFeedCacheKey = async (userId, pageKey, limit) => {
  const version = await getFeedVersion(userId);
  return `feed:v${version}:${userId}:${pageKey}:${limit}`;
};

// O(1) invalidation: bump the version counter. No SCAN, no DEL.
export const invalidateFeedCache = async (userId) => {
  try {
    await redisClient.incr(`feedVersion:${userId}`);
  } catch {
    // Redis down — skip
  }
};

export default redisClient;
