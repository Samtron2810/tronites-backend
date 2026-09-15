import Post from "../models/Post.js";
import Report from "../models/Report.js";
import { hammingDistance } from "../utils/simhash.js";

// Phase 7+ — spam cluster detection. Per-account heuristics
// (moderationHeuristics.js) and the AI classifier (aiModerationService.js)
// both judge one post at a time and can't see coordination: the same
// (or lightly reworded) spam text posted from many different accounts
// in a short window. This sweep finds that pattern using simhash
// near-duplicate text fingerprints (utils/simhash.js), computed at
// post-creation time in preModerationService.js and stored on every
// post as contentHash/hashBands.
//
// LSH bucketing, not O(n^2) pairwise comparison: two posts are
// candidate near-duplicates if they share ANY of the 4 simhash bands.
// Hamming distance is then verified exactly before anything is
// flagged, so a band collision alone (~1/65536 chance per unrelated
// pair) never triggers a report on its own. Same-account matches are
// skipped entirely — that's the existing posting-velocity heuristic's
// job, not this one; this sweep exists specifically for coordination
// ACROSS accounts.

const WINDOW_MS =
  parseInt(process.env.SPAM_CLUSTER_WINDOW_MINUTES || "360", 10) * 60 * 1000;
// First-guess default (same "tunable against real firings" philosophy
// as MODERATION_* in moderationHeuristics.js — every match is logged
// with its exact distance below). Empirically, short social posts
// (~100-200 chars) need a looser threshold than the "few bits" figure
// often quoted for simhash on long documents: a single inserted/edited
// word among a handful of shingles moves a larger share of the 64-bit
// vote than it would in a full page of text. MIN_DISTINCT_ACCOUNTS is
// the real backstop against false positives here, not a tight Hamming
// cutoff — a coincidental near-collision across 3+ independent
// accounts in one window is very unlikely even at this threshold.
const HAMMING_THRESHOLD = parseInt(
  process.env.SPAM_CLUSTER_HAMMING_THRESHOLD || "12",
  10,
);
const MIN_DISTINCT_ACCOUNTS = parseInt(
  process.env.SPAM_CLUSTER_MIN_ACCOUNTS || "3",
  10,
);

// Simple union-find so posts chain transitively into one cluster
// (A~B, B~C => {A,B,C}) even where A and C themselves fall just
// outside the Hamming threshold — real copy-paste spam runs tend to
// drift slightly further from the original with each re-share.
class UnionFind {
  constructor(ids) {
    this.parent = new Map(ids.map((id) => [id, id]));
  }
  find(x) {
    while (this.parent.get(x) !== x) {
      this.parent.set(x, this.parent.get(this.parent.get(x)));
      x = this.parent.get(x);
    }
    return x;
  }
  union(a, b) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

export const detectSpamClusters = async () => {
  try {
    const since = new Date(Date.now() - WINDOW_MS);
    const posts = await Post.find({
      createdAt: { $gte: since },
      removedAt: null,
      contentHash: { $ne: null },
    })
      .select("_id user contentHash hashBands")
      .lean();

    if (posts.length < 2) return { clustersFound: 0, postsFlagged: 0 };

    // Candidate pairs via band collision: key by (band position, value)
    // so a match in band 0 never collides with an unrelated match in
    // band 2 that happens to carry the same 16-bit value.
    const byBand = new Map();
    for (const post of posts) {
      (post.hashBands || []).forEach((value, bandIdx) => {
        const key = `${bandIdx}:${value}`;
        if (!byBand.has(key)) byBand.set(key, []);
        byBand.get(key).push(post._id.toString());
      });
    }

    const byId = new Map(posts.map((p) => [p._id.toString(), p]));
    const uf = new UnionFind([...byId.keys()]);

    for (const candidateIds of byBand.values()) {
      if (candidateIds.length < 2) continue;
      for (let i = 0; i < candidateIds.length; i++) {
        for (let j = i + 1; j < candidateIds.length; j++) {
          const a = byId.get(candidateIds[i]);
          const b = byId.get(candidateIds[j]);
          if (a.user.toString() === b.user.toString()) continue;
          const distance = hammingDistance(a.contentHash, b.contentHash);
          if (distance <= HAMMING_THRESHOLD) {
            console.log(
              `[detectSpamClusters] candidate match: posts ${a._id} / ${b._id}, Hamming ${distance}`,
            );
            uf.union(candidateIds[i], candidateIds[j]);
          }
        }
      }
    }

    const clusters = new Map();
    for (const id of byId.keys()) {
      const root = uf.find(id);
      if (!clusters.has(root)) clusters.set(root, []);
      clusters.get(root).push(id);
    }

    let clustersFound = 0;
    let postsFlagged = 0;

    for (const memberIds of clusters.values()) {
      if (memberIds.length < 2) continue;
      const distinctAccounts = new Set(
        memberIds.map((id) => byId.get(id).user.toString()),
      );
      if (distinctAccounts.size < MIN_DISTINCT_ACCOUNTS) continue;

      clustersFound += 1;
      for (const postId of memberIds) {
        const post = byId.get(postId);
        const raised = await Report.findOneAndUpdate(
          { system: true, targetType: "post", targetId: post._id },
          {
            $setOnInsert: {
              targetType: "post",
              targetId: post._id,
              targetOwner: post.user,
              reason: "spam",
              details: `Coordinated spam cluster: near-duplicate text across ${distinctAccounts.size} accounts.`,
              system: true,
              priority: "high",
              status: "open",
            },
            $addToSet: { signals: "spam_cluster" },
          },
          { upsert: true, setDefaultsOnInsert: true },
        );
        if (raised) postsFlagged += 1;
      }
    }

    if (clustersFound > 0) {
      console.log(
        `[detectSpamClusters] ${clustersFound} cluster(s) found; ${postsFlagged} post(s) flagged ` +
          `(>= ${MIN_DISTINCT_ACCOUNTS} distinct accounts, Hamming <= ${HAMMING_THRESHOLD}).`,
      );
    }
    return { clustersFound, postsFlagged };
  } catch (error) {
    // A background sweep must never crash the process.
    console.error("[detectSpamClusters] failed:", error.message);
    return { clustersFound: 0, postsFlagged: 0 };
  }
};
