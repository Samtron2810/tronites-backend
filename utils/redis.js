import { createClient } from "redis";

const redisClient = createClient({
  url: process.env.REDIS_URL || "redis://localhost:6379",
});

redisClient.on("error", (err) => console.error("Redis Client Error", err));
redisClient.on("connect", () => console.log("Redis connected"));

// Connect on init (non-blocking)
(async () => {
  try {
    await redisClient.connect();
  } catch (err) {
    console.warn("Redis connection failed — caching disabled:", err.message);
  }
})();

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

    for await (const key of redisClient.scanIterator({
      MATCH: pattern,
      COUNT: 100,
    })) {
      keysToDelete.push(key);
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

export default redisClient;
