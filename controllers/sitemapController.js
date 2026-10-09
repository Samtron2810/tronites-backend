import User from "../models/User.js";
import Post from "../models/Post.js";
import { PUBLIC_ONLY_FILTER, PUBLISHED_FILTER } from "../services/postVisibilityService.js";
import { getOrSetCache } from "../utils/redis.js";

const SITE_URL = process.env.SITE_URL || "https://tronites.com";

// Caps keep the sitemap generation bounded and each individual sitemap
// file under Google's 50k-URL/50MB limits — comfortably so, since a
// sitemap index (below) is the real scaling answer once any one category
// passes this, not a single ever-growing file.
const MAX_PROFILES = 20000;
const MAX_POSTS = 20000;
const MAX_HASHTAGS = 5000;

// A hashtag with fewer than this many total public posts is excluded
// entirely (not just noindexed — plan §5/§8: "Add noindex for empty,
// thin or low-quality hashtag pages" and "Exclude ... Empty or thin
// hashtag pages" from the sitemap specifically). Matches
// PublicHashtag.jsx's THIN_PAGE_THRESHOLD on the frontend.
const THIN_HASHTAG_THRESHOLD = 3;

const xmlEscape = (str) =>
  String(str).replace(/[<>&'"]/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]),
  );

const urlEntry = (loc, { lastmod, changefreq, priority } = {}) => {
  let entry = `  <url>\n    <loc>${xmlEscape(loc)}</loc>\n`;
  if (lastmod) entry += `    <lastmod>${new Date(lastmod).toISOString()}</lastmod>\n`;
  if (changefreq) entry += `    <changefreq>${changefreq}</changefreq>\n`;
  if (priority !== undefined) entry += `    <priority>${priority}</priority>\n`;
  entry += `  </url>\n`;
  return entry;
};

const wrapUrlset = (entries) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join("")}</urlset>\n`;

const wrapSitemapIndex = (sitemaps) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${sitemaps
    .map((loc) => `  <sitemap>\n    <loc>${xmlEscape(loc)}</loc>\n  </sitemap>\n`)
    .join("")}</sitemapindex>\n`;

// GET /sitemap.xml — the top-level index. Always cheap/fast: it just
// lists the child sitemap URLs, none of which are computed here.
export const getSitemapIndex = async (req, res) => {
  const sitemaps = [
    `${SITE_URL}/sitemap-static.xml`,
    `${SITE_URL}/sitemap-profiles.xml`,
    `${SITE_URL}/sitemap-posts.xml`,
    `${SITE_URL}/sitemap-hashtags.xml`,
  ];
  res.set("Content-Type", "application/xml");
  res.status(200).send(wrapSitemapIndex(sitemaps));
};

// GET /sitemap-static.xml — the hand-maintained public pages (Landing,
// help, tiers, legal, explore). Static content, so this list is
// literal rather than queried — same URLs Phase 2/4 already made public.
export const getStaticSitemap = async (req, res) => {
  const entries = [
    urlEntry(`${SITE_URL}/`, { changefreq: "weekly", priority: "1.0" }),
    urlEntry(`${SITE_URL}/explore`, { changefreq: "hourly", priority: "0.8" }),
    urlEntry(`${SITE_URL}/help`, { changefreq: "monthly", priority: "0.5" }),
    urlEntry(`${SITE_URL}/tiers`, { changefreq: "monthly", priority: "0.5" }),
    urlEntry(`${SITE_URL}/privacy`, { changefreq: "monthly", priority: "0.3" }),
    urlEntry(`${SITE_URL}/terms`, { changefreq: "monthly", priority: "0.3" }),
    urlEntry(`${SITE_URL}/guidelines`, { changefreq: "monthly", priority: "0.3" }),
    urlEntry(`${SITE_URL}/refunds`, { changefreq: "monthly", priority: "0.3" }),
    urlEntry(`${SITE_URL}/copyright`, { changefreq: "monthly", priority: "0.3" }),
  ];
  res.set("Content-Type", "application/xml");
  res.status(200).send(wrapUrlset(entries));
};

// GET /sitemap-profiles.xml — every eligible public profile, using the
// EXACT same eligibility rule publicUserController.getPublicUserProfile
// enforces (not isPrivate, not deleted, not banned, not suspended) — a
// profile that would 404 on /u/:username has no business being in the
// sitemap that's supposed to only ever point at real, crawlable pages.
export const getProfilesSitemap = async (req, res) => {
  const xml = await getOrSetCache(
    "sitemap:profiles",
    async () => {
      const users = await User.find({
        isPrivate: { $ne: true },
        deletedAt: null,
        banned: { $ne: true },
        $or: [{ suspendedUntil: null }, { suspendedUntil: { $lte: new Date() } }],
        username: { $exists: true, $ne: null },
      })
        .select("username updatedAt")
        .sort({ updatedAt: -1 })
        .limit(MAX_PROFILES);

      const entries = users.map((u) =>
        urlEntry(`${SITE_URL}/u/${u.username}`, {
          lastmod: u.updatedAt,
          changefreq: "daily",
          priority: "0.6",
        }),
      );
      return wrapUrlset(entries);
    },
    // Longer TTL than the public API's own 60s caches — the sitemap is
    // read by crawlers, not by visitors waiting on a page, so freshness
    // matters far less than not re-running a collection scan on every
    // crawl request. An hour-old sitemap entry for a profile that just
    // went private is a brief false positive at worst; the profile page
    // itself (Phase 3's actual access control) still 404s a private
    // profile regardless of what the sitemap says.
    3600,
  );

  res.set("Content-Type", "application/xml");
  res.status(200).send(xml);
};

// GET /sitemap-posts.xml — every eligible public, published post, using
// the same PUBLIC_ONLY_FILTER + PUBLISHED_FILTER combination
// publicPostController.getPublicPostById enforces.
export const getPostsSitemap = async (req, res) => {
  const xml = await getOrSetCache(
    "sitemap:posts",
    async () => {
      const posts = await Post.find({
        removedAt: null,
        ...PUBLISHED_FILTER,
        ...PUBLIC_ONLY_FILTER,
      })
        .select("_id createdAt")
        .sort({ createdAt: -1 })
        .limit(MAX_POSTS);

      const entries = posts.map((p) =>
        urlEntry(`${SITE_URL}/post/${p._id}`, {
          lastmod: p.createdAt,
          changefreq: "monthly",
          priority: "0.5",
        }),
      );
      return wrapUrlset(entries);
    },
    3600,
  );

  res.set("Content-Type", "application/xml");
  res.status(200).send(xml);
};

// GET /sitemap-hashtags.xml — only hashtags clearing THIN_HASHTAG_THRESHOLD
// public posts (plan §5/§8: exclude empty/thin tags from the sitemap
// entirely, not just noindex them — noindex is what the page itself does
// for a thin-but-nonzero tag; the sitemap goes further and never lists
// one below the threshold at all).
export const getHashtagsSitemap = async (req, res) => {
  const xml = await getOrSetCache(
    "sitemap:hashtags",
    async () => {
      const results = await Post.aggregate([
        { $match: { removedAt: null, ...PUBLISHED_FILTER, ...PUBLIC_ONLY_FILTER } },
        { $unwind: "$hashtags" },
        {
          $group: {
            _id: "$hashtags",
            count: { $sum: 1 },
            lastPost: { $max: "$createdAt" },
          },
        },
        { $match: { count: { $gte: THIN_HASHTAG_THRESHOLD } } },
        { $sort: { count: -1 } },
        { $limit: MAX_HASHTAGS },
      ]);

      const entries = results.map((r) =>
        urlEntry(`${SITE_URL}/hashtag/${r._id}`, {
          lastmod: r.lastPost,
          changefreq: "daily",
          priority: "0.4",
        }),
      );
      return wrapUrlset(entries);
    },
    3600,
  );

  res.set("Content-Type", "application/xml");
  res.status(200).send(xml);
};
