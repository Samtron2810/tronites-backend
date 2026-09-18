import Report from "../models/Report.js";
import Post from "../models/Post.js";
import Comment from "../models/Comment.js";
import Message from "../models/Message.js";
import {
  checkSlurList,
  checkLinkSpam,
  checkAllCapsRatio,
  checkNewAccountWithLink,
  checkPostingVelocity,
} from "../utils/moderationHeuristics.js";
import { classifyContent } from "./aiModerationService.js";
import { computeSimhash, simhashBands } from "../utils/simhash.js";

// Phase 7 — automated pre-moderation (roadmap 3.2). Runs cheap text/
// account heuristics PLUS an AI classifier (see aiModerationService.js)
// against newly created OR edited content and, if anything fires, raises
// a system-authored Report at "high" priority straight into the existing
// moderation queue (see reportService.listReports) — reusing Phase
// 1/6 infra instead of building a parallel review surface.
//
// Covers posts (create + video-post create + edit), comments/replies
// (Comment doc covers both — see commentController.addComment), and DMs
// (Message doc — text and/or media captions). Re-running against the
// same targetId (e.g. a post edit) is safe: the {system:1, targetType:1,
// targetId:1} partial unique index means the upsert below merges new
// signals into the existing open system report instead of duplicating
// the queue entry.
//
// Deliberately never deletes, hides, or blocks content itself: a human
// moderator resolves the report exactly like any other, via
// PUT /reports/:id/resolve. This keeps the same "route to review, don't
// auto-delete" guarantee the roadmap calls for.
//
// Called fire-and-forget from controllers (createPost, createVideoPost,
// editPost, addComment, sendMessage/sendVideoMessage/sendVoiceMessage) —
// a slow or failed pre-moderation pass (including the network call to
// the AI provider) must never delay or break content creation.

const TARGET_MODEL_BY_TYPE = { post: Post, comment: Comment, message: Message };

// Velocity heuristic counts recent items from the same author. Post and
// Comment key the author on `user`; Message keys it on `sender` — same
// person, different field name — so the count query needs to know which
// field to filter on per targetType.
const AUTHOR_FIELD_BY_TYPE = { post: "user", comment: "user", message: "sender" };

/**
 * Run heuristics + AI classification against a piece of just-created or
 * just-edited content and, if any signal fires, upsert a system Report
 * at high priority.
 *
 * @param {"post"|"comment"|"message"} targetType
 * @param {object} target        The document (post/comment/message) — needs _id, text, images.
 * @param {object} author        The author's User doc — needs _id, createdAt.
 * @returns {Promise<{flagged: boolean, signals: string[], aiFlags: object[]}>}
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

    // Velocity check needs one indexed count query — cheap (Post/Comment/
    // Message already index {user|sender, createdAt} implicitly via their
    // own query patterns).
    const Model = TARGET_MODEL_BY_TYPE[targetType];
    const authorField = AUTHOR_FIELD_BY_TYPE[targetType];
    if (Model && authorField && author?._id) {
      const { MODERATION_THRESHOLDS } = await import(
        "../utils/moderationHeuristics.js"
      );
      const since = new Date(Date.now() - MODERATION_THRESHOLDS.VELOCITY_WINDOW_MS);
      const recentCount = await Model.countDocuments({
        [authorField]: author._id,
        createdAt: { $gte: since },
      });
      const velocity = checkPostingVelocity(recentCount);
      if (velocity) signals.push(velocity);
    }

    // AI classification — toxicity/NSFW/policy-violating text AND
    // image content in a single provider call. Confidence-scored per
    // category; stored on the Report as `aiFlags` so the moderation
    // queue can surface *why* something was flagged, not just that it
    // was. A provider outage/timeout degrades to "no AI signal" (see
    // aiModerationService.js) — never throws, never blocks the rest of
    // this pass.
    const imageUrls = (target.images || [])
      .map((img) => (typeof img === "string" ? img : img?.url))
      .filter(Boolean);
    const aiResult = await classifyContent({ text, imageUrls });
    if (aiResult.flagged) signals.push("ai_moderation");

    // Spam-cluster fingerprint — stored on every post (flagged or not)
    // so jobs/detectSpamClusters.js can later find near-duplicate text
    // across DIFFERENT accounts, a coordination pattern per-account
    // heuristics and the AI classifier (both single-item judgments)
    // can't see. See utils/simhash.js.
    if (targetType === "post" && target._id) {
      const contentHash = computeSimhash(text);
      if (contentHash) {
        await Post.updateOne(
          { _id: target._id },
          { $set: { contentHash, hashBands: simhashBands(contentHash) } },
        );
      }
    }

    if (!signals.length) {
      return { flagged: false, signals: [], aiFlags: [] };
    }

    // Idempotent per-target: the {system:1, targetType:1, targetId:1}
    // partial unique index means a re-run (e.g. an edit re-triggering
    // this) merges signals into the existing open system report instead
    // of creating a duplicate queue entry. aiFlags is overwritten
    // ($set, not $addToSet) each run — it reflects the latest
    // classification, not an accumulating history of every past score.
    const update = {
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
    };
    if (aiResult.categories.length) {
      update.$set = { aiFlags: aiResult.categories };
    }

    await Report.findOneAndUpdate(
      { system: true, targetType, targetId: target._id },
      update,
      { upsert: true, setDefaultsOnInsert: true },
    );

    console.log(
      `[preModeration] ${targetType} ${target._id} flagged: ${signals.join(", ")}`,
    );

    return { flagged: true, signals, aiFlags: aiResult.categories };
  } catch (error) {
    // A pre-moderation failure must never break content creation.
    console.error("[preModeration] failed:", error.message);
    return { flagged: false, signals: [], aiFlags: [] };
  }
};
