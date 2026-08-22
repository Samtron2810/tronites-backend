import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import { beforeAll, afterAll, afterEach } from "vitest";

// Runs the whole suite against a real (in-memory) MongoDB rather than
// mocking Mongoose — these are smoke tests exercising actual routes end
// to end (see tests/*.test.js), so a real DB engine matters: unique
// index violations, $inc atomicity, population, etc. all need to behave
// like production Mongo, which an in-memory mock of the driver
// wouldn't reliably reproduce.
//
// First run downloads a MongoDB binary from fastdl.mongodb.org (cached
// afterward in node_modules/.cache) — needs outbound network access to
// that host. In a network-restricted environment (locked-down CI
// runner, sandboxed dev container) this download will fail; run once
// somewhere unrestricted first, or set MONGOMS_DOWNLOAD_MIRROR to an
// internally-reachable mirror.
let mongod;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
}, 30000);

afterEach(async () => {
  // Wipe all collections between tests so one test's data can't leak
  // into another's assertions — cheaper than restarting the whole
  // in-memory server per test.
  const collections = mongoose.connection.collections;
  await Promise.all(
    Object.values(collections).map((collection) => collection.deleteMany({})),
  );
});

afterAll(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.connection.close();
  await mongod.stop();
});
