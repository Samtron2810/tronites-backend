import mongoose from "mongoose";

// Opaque keyset cursor over (createdAt desc, _id desc) — the position of the
// last row a client received. Sent back as `?cursor=<value>`; "start" (or
// empty) means "first page". Unlike skip/offset, cost doesn't grow with depth
// and rows inserted mid-scroll can't shift pages into duplicates/gaps.
export const encodeCursor = (doc) =>
  `${new Date(doc.createdAt).getTime()}_${doc._id}`;

export const decodeCursor = (raw) => {
  if (typeof raw !== "string") return null;
  const [ms, id] = raw.split("_");
  const t = Number(ms);
  if (!Number.isFinite(t) || !id || !mongoose.Types.ObjectId.isValid(id)) {
    return null;
  }
  return { createdAt: new Date(t), _id: new mongoose.Types.ObjectId(id) };
};

// Rows strictly after the cursor in (createdAt desc, _id desc) order.
export const afterCursorFilter = (c) => ({
  $or: [
    { createdAt: { $lt: c.createdAt } },
    { createdAt: c.createdAt, _id: { $lt: c._id } },
  ],
});

// Reads ?cursor. Returns { useCursor, cursor, invalid }.
export const parseCursorParam = (raw) => {
  if (raw === undefined) return { useCursor: false, cursor: null, invalid: false };
  const s = String(raw);
  if (s === "" || s === "start") return { useCursor: true, cursor: null, invalid: false };
  const cursor = decodeCursor(s);
  return { useCursor: true, cursor, invalid: !cursor };
};
