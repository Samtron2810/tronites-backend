import rateLimit, { MemoryStore } from "express-rate-limit";
import { RedisStore } from "rate-limit-redis";
import redisClient, { isRedisReady } from "../utils/redis.js";

// express-rate-limit defaults to an in-memory store — each counts requests
// only for the process it's running in. With one instance that's fine, but
// the moment you run 2+ instances behind a load balancer, a client's
// requests get split across processes and each one thinks the client is
// under the limit. A shared Redis store makes the count correct no matter
// how many instances are running.
//
// FallbackStore routes every call to RedisStore when Redis is up, and to
// a local MemoryStore when it's down. This is NOT the same as disabling
// rate limiting during an outage — limiting keeps working, it just stops
// being shared across instances until Redis comes back. (An earlier
// version of this file used `passOnStoreError: true` to let requests
// through on Redis errors, which meant a Redis outage removed rate
// limiting entirely — that's the bug this class fixes.)
class FallbackStore {
  constructor(prefix) {
    this.prefix = prefix;
    // Not built here — see _rebuild() below for why.
    this.redisStore = null;
    this.memoryStore = new MemoryStore();
    this._initOptions = null;

    // rate-limit-redis's RedisStore caches its Lua-script-SHA lookups as
    // promises, assigned once inside init(): `this.incrementScriptSha =
    // this.loadIncrementScript()`. If that promise rejects — which it
    // always does here, since express-rate-limit constructs stores (and
    // calls init() on them) at module-import time, before this app's
    // bootstrap ever calls connectRedis() — every future increment()/get()
    // call does `await this.incrementScriptSha` first and immediately
    // re-throws that same stale rejection, forever. A single failed
    // init() permanently disables that RedisStore instance, even after
    // the underlying client successfully connects later — verified
    // empirically. Rebuilding a fresh RedisStore (and re-running its
    // init()) on every 'ready' event sidesteps that: the client's 'ready'
    // event fires the first time it connects AND on every reconnect after
    // a later drop, so this is what gives real self-healing here.
    redisClient.on("ready", () => {
      this._rebuild();
    });
  }

  _rebuild() {
    const store = new RedisStore({
      sendCommand: (...args) => redisClient.sendCommand(args),
      prefix: this.prefix,
    });
    this.redisStore = store;
    if (this._initOptions) {
      store.init(this._initOptions).catch((err) => {
        console.warn(`Rate limit Redis store re-init failed: ${err.message}`);
      });
    }
  }

  // express-rate-limit calls init() once per store with the resolved
  // options (windowMs etc). Both stores need it — whichever one ends up
  // handling a given request must already be initialized.
  async init(options) {
    this._initOptions = options;
    if (isRedisReady()) {
      this._rebuild();
    }
    // If Redis isn't ready yet, the 'ready' listener above builds and
    // initializes redisStore the moment it connects — nothing more to do
    // here for that case.
    await this.memoryStore.init?.(options);
  }

  _active() {
    return isRedisReady() && this.redisStore
      ? this.redisStore
      : this.memoryStore;
  }

  async increment(key) {
    try {
      if (isRedisReady() && this.redisStore) {
        return await this.redisStore.increment(key);
      }
    } catch (err) {
      console.warn(
        `Rate limit Redis increment failed, falling back to memory: ${err.message}`,
      );
    }
    // Falling back here means this window's count for `key` starts fresh
    // in memory rather than continuing the Redis count — acceptable,
    // since the alternative (no limiting at all) is worse.
    return this.memoryStore.increment(key);
  }

  async decrement(key) {
    // Best-effort on whichever store is currently active; a decrement
    // that lands on the "wrong" store after a mid-window failover just
    // means one store's count is slightly off, which self-corrects when
    // that window expires.
    try {
      await this._active().decrement(key);
    } catch (err) {
      console.warn(`Rate limit decrement failed: ${err.message}`);
    }
  }

  async resetKey(key) {
    if (this.redisStore) {
      try {
        await this.redisStore.resetKey(key);
      } catch {
        // ignore — Redis may be down
      }
    }
    try {
      await this.memoryStore.resetKey(key);
    } catch {
      // ignore
    }
  }
}

const makeStore = (prefix) => new FallbackStore(prefix);

// General API limiter — 100 requests per 15 minutes (only for write operations)
// GET requests are skipped to allow unlimited navigation
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  message: {
    message: "Too many requests, please try again later.",
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === "GET",
  store: makeStore("rl:api:"),
});

// Auth limiter (register/login) — 10 requests per 15 minutes
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: {
    message: "Too many authentication attempts, please try again later.",
  },
  standardHeaders: true,
  legacyHeaders: false,
  store: makeStore("rl:auth:"),
});

// Post creation limiter — 30 posts per hour
export const postLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  message: {
    message: "Too many posts created, please slow down.",
  },
  standardHeaders: true,
  legacyHeaders: false,
  store: makeStore("rl:post:"),
});

// Post edit limiter — separate from postLimiter (creation) since edits
// are typically fixing a typo, not new content; a tighter shared budget
// would make someone spend their post quota just to correct one.
export const editPostLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  message: {
    message: "Too many edits, please slow down.",
  },
  standardHeaders: true,
  legacyHeaders: false,
  store: makeStore("rl:editpost:"),
});

// Comment limiter — 60 comments per hour
export const commentLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 60,
  message: {
    message: "Too many comments, please slow down.",
  },
  standardHeaders: true,
  legacyHeaders: false,
  store: makeStore("rl:comment:"),
});

// Message limiter — 100 messages per hour
export const messageLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 100,
  message: {
    message: "Too many messages, please slow down.",
  },
  standardHeaders: true,
  legacyHeaders: false,
  store: makeStore("rl:message:"),
});

// Account deletion limiter — accepts a password guess (confirmation
// before an irreversible action), so it needs the same brute-force
// protection as login. Kept as its own bucket rather than reusing
// authLimiter so a burst of real login attempts and a burst of deletion
// attempts from the same IP don't consume each other's budget.
export const accountDeletionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: {
    message: "Too many account deletion attempts, please try again later.",
  },
  standardHeaders: true,
  legacyHeaders: false,
  store: makeStore("rl:deleteaccount:"),
});

// Report limiter — 15 reports per hour. Reports were previously only
// covered by the generic apiLimiter (100 writes/15min shared with every
// other write action), which is loose enough to let one account file
// dozens of reports against a single target, or flood the moderation
// queue. This is deliberately tighter and its own bucket: legitimate use
// is "I saw a handful of bad things today", not "I file 100 reports".
export const reportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 15,
  message: {
    message: "Too many reports submitted, please try again later.",
  },
  standardHeaders: true,
  legacyHeaders: false,
  store: makeStore("rl:report:"),
});
