// Collapses a page of raw Notification docs into display-ready rows:
// "Ada and 39 others liked your post" instead of 40 separate rows.
//
// Only `like`, `commentLike`, and `follow` are grouped — these are the
// types where N events about the same target are functionally
// identical from the recipient's point of view (you don't need to see
// each individual like separately). `comment`, `reply`, `mention`, and
// `moderator_warning` are left ungrouped: each one carries distinct
// content (a different comment, a different reply, a specific warning
// reason) that collapsing would hide.
//
// Grouping key:
//   like/commentLike -> (type, post OR comment, read) — same target,
//                        same read-state, i.e. reading the group as a
//                        whole should mark every member read together.
//   follow            -> (type, read) — no per-target scoping, since a
//                        follow has no post/comment; every unread
//                        follow within the read-state bucket collapses
//                        into one row.
//
// Deliberately NOT bucketed by a time window on top of that — grouping
// only within a single fetched page (typically the last 20-50
// notifications) already bounds how far apart in time a group's
// members can be, without the extra complexity of picking a bucket
// size that has to agree with pagination boundaries.
const GROUPABLE_TYPES = new Set(["like", "commentLike", "follow"]);

const groupKeyFor = (n) => {
  if (n.type === "follow") return `follow:${n.read}`;
  if (n.type === "like") return `like:${n.post?._id || n.post}:${n.read}`;
  if (n.type === "commentLike")
    return `commentLike:${n.comment?._id || n.comment}:${n.read}`;
  return null;
};

// notifications: array of populated Notification docs (lean or mongoose
// docs — only reads fields, never mutates). Returns display rows in the
// same relative order as the input (each row takes the position of its
// first/newest member), each row shaped as:
//   {
//     _id,            // the newest member's id — stable React key
//     type,
//     post, comment, message, read, createdAt,   // from newest member
//     actors: [sender, ...],  // up to 3 populated sender docs, newest first
//     othersCount,             // additional distinct actors beyond the 3 shown
//     groupSize,               // total notifications collapsed into this row
//     memberIds,                // every raw notification _id in the group (for mark-read/local state)
//   }
export const groupNotifications = (notifications) => {
  const rows = [];
  const rowByKey = new Map();

  for (const n of notifications) {
    const key = GROUPABLE_TYPES.has(n.type) ? groupKeyFor(n) : null;

    if (!key) {
      rows.push({
        _id: n._id,
        type: n.type,
        post: n.post,
        comment: n.comment,
        message: n.message,
        read: n.read,
        createdAt: n.createdAt,
        actors: n.sender ? [n.sender] : [],
        othersCount: 0,
        groupSize: 1,
        memberIds: [n._id],
      });
      continue;
    }

    const existing = rowByKey.get(key);
    if (!existing) {
      const row = {
        _id: n._id,
        type: n.type,
        post: n.post,
        comment: n.comment,
        message: n.message,
        read: n.read,
        createdAt: n.createdAt,
        actors: n.sender ? [n.sender] : [],
        othersCount: 0,
        groupSize: 1,
        memberIds: [n._id],
        // Track sender ids we've already counted so the same person
        // liking-then-unliking-then-liking again within one page (if
        // that ever produced duplicate docs) doesn't double-count in
        // othersCount. Not exposed on the returned row.
        _seenSenderIds: new Set(n.sender ? [String(n.sender._id)] : []),
      };
      rowByKey.set(key, row);
      rows.push(row);
      continue;
    }

    existing.groupSize += 1;
    existing.memberIds.push(n._id);

    const senderId = n.sender ? String(n.sender._id) : null;
    if (senderId && !existing._seenSenderIds.has(senderId)) {
      existing._seenSenderIds.add(senderId);
      if (existing.actors.length < 3) {
        existing.actors.push(n.sender);
      } else {
        existing.othersCount += 1;
      }
    }
  }

  // Strip the internal tracking field before returning.
  return rows.map(({ _seenSenderIds, ...row }) => row);
};
