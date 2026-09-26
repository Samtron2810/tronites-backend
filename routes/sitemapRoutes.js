import express from "express";
import {
  getSitemapIndex,
  getStaticSitemap,
  getProfilesSitemap,
  getPostsSitemap,
  getHashtagsSitemap,
} from "../controllers/sitemapController.js";

const router = express.Router();

// Mounted directly on `app` at the root, NOT under /api (see index.js) —
// /sitemap.xml is the conventional, crawler-expected location. GET-only,
// public, unauthenticated by nature (a sitemap that required a session
// would be useless to search engines).
router.get("/sitemap.xml", getSitemapIndex);
router.get("/sitemap-static.xml", getStaticSitemap);
router.get("/sitemap-profiles.xml", getProfilesSitemap);
router.get("/sitemap-posts.xml", getPostsSitemap);
router.get("/sitemap-hashtags.xml", getHashtagsSitemap);

export default router;
