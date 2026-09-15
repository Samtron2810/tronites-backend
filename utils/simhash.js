// 64-bit Simhash for near-duplicate text detection (roadmap 3.2 — spam
// cluster detection). Near-identical text (copy-pasted spam with minor
// edits/swapped links/emoji) produces hashes with a small Hamming
// distance; unrelated text differs in ~32 of the 64 bits on average.
// Pure/sync/zero-dependency, same constraint as moderationHeuristics.js
// — cheap enough to run inline on every post.

// Character n-grams, not word n-grams: a single inserted/deleted word
// shifts every downstream *word* shingle, wrecking the Hamming distance
// for what's otherwise near-identical spam text. A character n-gram
// only loses the handful of shingles that overlap the edit itself —
// standard practice for simhash-based near-dup detection.
const SHINGLE_SIZE = 5;

// FNV-1a 32-bit — fast, zero-dependency, good-enough avalanche for LSH
// fingerprinting (not a cryptographic use case).
const fnv1a = (str, seed) => {
  let hash = seed;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
};

// 64-bit token hash from two independently-seeded 32-bit FNV-1a passes
// — avoids a BigInt-hashing dependency while giving the simhash bit
// vector below full 64-bit spread.
const hashToken = (token) => {
  const hi = fnv1a(token, 0x811c9dc5);
  const lo = fnv1a(token, 0x9747b28c);
  return (BigInt(hi) << 32n) | BigInt(lo);
};

const normalize = (text = "") =>
  text
    .toLowerCase()
    // Links vary per spam run (tracking params, shorteners) — stripped
    // so they don't mask identical body text under the shingle set.
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^a-z0-9\s#@]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const shingles = (normalized) => {
  if (normalized.length < SHINGLE_SIZE) {
    return normalized ? [normalized] : [];
  }
  const out = [];
  for (let i = 0; i <= normalized.length - SHINGLE_SIZE; i++) {
    out.push(normalized.slice(i, i + SHINGLE_SIZE));
  }
  return out;
};

/**
 * Computes a 64-bit simhash fingerprint for a piece of text, returned
 * as a zero-padded 16-char hex string. Returns null for text too short
 * to fingerprint meaningfully — avoids two near-empty posts colliding
 * on a near-meaningless hash.
 */
export const computeSimhash = (text) => {
  const normalized = normalize(text);
  if (normalized.length < SHINGLE_SIZE) return null;

  const vector = new Array(64).fill(0);
  for (const shingle of shingles(normalized)) {
    const hash = hashToken(shingle);
    for (let bit = 0; bit < 64; bit++) {
      vector[bit] += (hash >> BigInt(bit)) & 1n ? 1 : -1;
    }
  }

  let fingerprint = 0n;
  for (let bit = 0; bit < 64; bit++) {
    if (vector[bit] > 0) fingerprint |= 1n << BigInt(bit);
  }
  return fingerprint.toString(16).padStart(16, "0");
};

/** Hamming distance between two hex-encoded 64-bit simhashes (0-64). */
export const hammingDistance = (hexA, hexB) => {
  if (!hexA || !hexB) return 64;
  let xor = BigInt(`0x${hexA}`) ^ BigInt(`0x${hexB}`);
  let distance = 0;
  while (xor > 0n) {
    distance += Number(xor & 1n);
    xor >>= 1n;
  }
  return distance;
};

const BAND_COUNT = 4;
const BAND_BITS = 64 / BAND_COUNT; // 16

/**
 * Splits a hex simhash into BAND_COUNT integer bands for LSH bucketing
 * — two hashes that agree on ANY band are Hamming-close with high
 * probability, so a spam-cluster sweep can find candidate pairs via
 * indexed equality queries (MongoDB multikey index) instead of an
 * O(n^2) pairwise comparison across every post in the window.
 */
export const simhashBands = (hex) => {
  if (!hex) return [];
  const full = BigInt(`0x${hex}`);
  const bands = [];
  for (let i = 0; i < BAND_COUNT; i++) {
    bands.push(Number((full >> BigInt(i * BAND_BITS)) & 0xffffn));
  }
  return bands;
};

export const SIMHASH_CONFIG = { SHINGLE_SIZE, BAND_COUNT, BAND_BITS };
