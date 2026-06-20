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
export const getOrSetCache = async (key, fetchFn, ttl = 60) => {
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
export const invalidateCache = async (pattern) => {
  try {
    const keys = await redisClient.keys(pattern);
    if (keys.length > 0) {
      await redisClient.del(keys);
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
