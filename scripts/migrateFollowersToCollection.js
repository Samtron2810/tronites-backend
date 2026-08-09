// One-time migration: moves existing User.followers / User.following
// array data into the new Follow collection, before those fields are
// removed from the User schema.
//
// Run this ONCE, before deploying the updated User model / controllers
// to production. If you're on a fresh database with no existing
// followers, you can skip this entirely.
//
// Usage:
//   node scripts/migrateFollowersToCollection.js
//
// Safe to re-run: uses upsert-style duplicate handling, so running it
// twice won't create duplicate edges.

import mongoose from "mongoose";
import dotenv from "dotenv";

dotenv.config();

// Raw collection access (not the Mongoose User model) because by the
// time this script is run against an already-updated codebase, the User
// schema may no longer declare followers/following — reading the raw
// collection avoids depending on the old schema.
const run = async () => {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) {
    console.error("MONGO_URI (or MONGODB_URI) not set in environment.");
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log("Connected to MongoDB");

  const db = mongoose.connection.db;
  const usersCollection = db.collection("users");
  const followsCollection = db.collection("follows");

  // Ensure the unique index exists before inserting (mirrors the Follow
  // model's schema index) so duplicates are rejected rather than piling up.
  await followsCollection.createIndex(
    { follower: 1, following: 1 },
    { unique: true },
  );
  await followsCollection.createIndex({ following: 1, createdAt: -1 });
  await followsCollection.createIndex({ follower: 1, createdAt: -1 });

  const cursor = usersCollection.find(
    {},
    { projection: { _id: 1, following: 1 } },
  );

  let usersProcessed = 0;
  let edgesInserted = 0;
  let edgesSkipped = 0;

  // Only reading `following` per user (not `followers`) is sufficient —
  // every "A follows B" relationship is captured once whether we read it
  // from A's `following` array or B's `followers` array, since the old
  // code kept both arrays in sync. Reading just one side avoids creating
  // duplicate edges from redundant data.
  for await (const user of cursor) {
    usersProcessed += 1;
    const following = Array.isArray(user.following) ? user.following : [];

    if (following.length === 0) continue;

    const now = new Date();
    const docs = following.map((followingId) => ({
      follower: user._id,
      following: followingId,
      createdAt: now,
      updatedAt: now,
    }));

    try {
      const result = await followsCollection.insertMany(docs, {
        ordered: false, // continue past duplicate-key errors within this batch
      });
      edgesInserted += result.insertedCount;
    } catch (err) {
      // BulkWriteError from duplicate keys (edge already migrated) is
      // expected on re-run — count what succeeded, skip the rest.
      if (err.result) {
        edgesInserted += err.result.insertedCount || 0;
        edgesSkipped += docs.length - (err.result.insertedCount || 0);
      } else {
        console.error(`Failed migrating edges for user ${user._id}:`, err.message);
      }
    }

    if (usersProcessed % 500 === 0) {
      console.log(`...${usersProcessed} users processed, ${edgesInserted} edges inserted so far`);
    }
  }

  console.log("Migration complete.");
  console.log(`Users processed: ${usersProcessed}`);
  console.log(`Edges inserted: ${edgesInserted}`);
  console.log(`Edges skipped (already existed): ${edgesSkipped}`);
  console.log(
    "\nNext step: verify counts look right, then it's safe to deploy the",
    "updated User model (which no longer has followers/following fields).",
    "The old array fields will simply stop being read/written — you can",
    "drop them later with a $unset if you want to reclaim space.",
  );

  await mongoose.disconnect();
  process.exit(0);
};

run().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
