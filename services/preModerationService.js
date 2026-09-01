import Report from "../models/Report.js";
import Post from "../models/Post.js";
import {
  checkSlurList,
  checkLinkSpam,
  checkAllCapsRatio,
  checkNewAccountWithLink,
  checkPostingVelocity,
} from "../utils/moderationHeuristics.js";

// Phase 7 — automated pre-moderation (roadmap 3.2). Runs cheap text/
// account heuristics against newly created content and, if any fire,
// raises a system-authored Report at "high" priority straight into the
// existing moderation queue (see reportService.listReports) — reusing
// Phase 1/6 infra instead of building a parallel review surface.
//
// Deliberately never deletes, hides, or blocks content itself: a human
// moderator resolves the report exactly like any other, via
// PUT /reports/:id/resolve. This keeps the same "route to review, don't
// auto-delete" guarantee the roadmap calls for.
//
// Called fire-and-forget from controllers (createPost etc.) — a slow or
// failed pre-moderation pass must never delay or break content creation.

const TARGET_MODEL_BY_TYPE = { post: Post };

/**
 * Run heuristics against a piece of just-created content and, if any
 * signal fires, upsert a system Report at high priority.
 *
 * @param {"post"} targetType
 * @param {object} target        The created document (post) — needs _id, text, user.
 * @param {object} author        The author's User doc — needs _id, createdAt.
 * @returns {Promise<{flagged: boolean, signals: string[]}>}
 */
export const runPreModeration = async ({ targetType, target, author }) => {
  try {
    const text = target.text || "";
    const signals = [];

    const slur = checkSlurList(text);
    if (slur) signals.push(slur);

    const linkSpam = checkLinkSpam(text);
    if (linkSpam) signals.push(linkSpam);

    const allCaps = checkAllCapsRatio(text);
    if (allCaps) signals.push(allCaps);

    const newAccountLink = checkNewAccountWithLink(text, author?.createdAt);
    if (newAccountLink) signals.push(newAccountLink);

    // Velocity check needs one indexed count query — cheap (Post already
    // indexes {user, createdAt} implicitly via the feed query patterns)
    // but skip it entirely if nothing else fired, to keep the common
    // (clean-content) case to zero extra DB round trips beyond the
    // moderator-content itself... actually always worth checking since
    // it's the only signal that catches otherwise-clean spam bursts.
    const Model = TARGET_MODEL_BY_TYPE[targetType];
    if (Model && author?._id) {
      const { MODERATION_THRESHOLDS } = await import(
        "../utils/moderationHeuristics.js"
      );
      const since = new Date(Date.now() - MODERATION_THRESHOLDS.VELOCITY_WINDOW_MS);
      const recentCount = await Model.countDocuments({
        user: author._id,
        createdAt: { $gte: since },
      });
      const velocity = checkPostingVelocity(recentCount);
      if (velocity) signals.push(velocity);
    }

    if (!signals.length) {
      return { flagged: false, signals: [] };
    }

    // Idempotent per-target: the {system:1, targetType:1, targetId:1}
    // partial unique index means a re-run (e.g. an edit re-triggering
    // this) merges signals into the existing open system report instead
    // of creating a duplicate queue entry.
    await Report.findOneAndUpdate(
      { system: true, targetType, targetId: target._id },
      {
        $setOnInsert: {
          targetType,
          targetId: target._id,
          targetOwner: author._id,
          reason: "other",
          details: "Automatically flagged by pre-moderation heuristics.",
          system: true,
          priority: "high",
          status: "open",
        },
        $addToSet: { signals: { $each: signals } },
      },
      { upsert: true, setDefaultsOnInsert: true },
    );

    console.log(
      `[preModeration] ${targetType} ${target._id} flagged: ${signals.join(", ")}`,
    );

    return { flagged: true, signals };
  } catch (error) {
    // A pre-moderation failure must never break content creation.
    console.error("[preModeration] failed:", error.message);
    return { flagged: false, signals: [] };
  }
};
