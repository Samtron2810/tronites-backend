// Phase 7+ — AI toxicity/NSFW/image classification, layered on top of
// the deterministic heuristics in utils/moderationHeuristics.js. This
// file only calls the provider and normalizes its response into
// { flagged, categories }; queuing/report creation stays in
// preModerationService.js so there's one place that owns "what happens
// when something is flagged".
//
// Provider is swappable via AI_MODERATION_PROVIDER (default "openai").
// Only OpenAI's Moderation API is implemented — Perspective API (text
// attributes) or Hive (visual moderation) are common alternatives and
// would slot in as additional branches in classifyContent() returning
// the same { flagged, categories } shape.

const PROVIDER = process.env.AI_MODERATION_PROVIDER || "openai";
const ENABLED =
  process.env.AI_MODERATION_ENABLED !== "false" && !!process.env.OPENAI_API_KEY;
const TEXT_SCORE_THRESHOLD = parseFloat(
  process.env.AI_MODERATION_TEXT_THRESHOLD || "0.5",
);
const IMAGE_SCORE_THRESHOLD = parseFloat(
  process.env.AI_MODERATION_IMAGE_THRESHOLD || "0.5",
);
const REQUEST_TIMEOUT_MS = parseInt(
  process.env.AI_MODERATION_TIMEOUT_MS || "8000",
  10,
);
// omni-moderation-latest accepts multi-modal input (text + image_url)
// in a single call — one request covers both text and image checks.
const MODEL = process.env.OPENAI_MODERATION_MODEL || "omni-moderation-latest";

const withTimeout = (promise, ms, label) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);

const callOpenAIModeration = async (input) => {
  const res = await withTimeout(
    fetch("https://api.openai.com/v1/moderations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({ model: MODEL, input }),
    }),
    REQUEST_TIMEOUT_MS,
    "AI moderation request",
  );
  if (!res.ok) throw new Error(`OpenAI moderation API returned ${res.status}`);
  const data = await res.json();
  return data.results?.[0] || null;
};

/**
 * Classifies a piece of content's text + up to 4 image URLs. Never
 * throws — a provider outage or missing API key degrades to "no AI
 * signal" rather than blocking the heuristic path or content creation
 * (callers only ever invoke this from the fire-and-forget
 * runPreModeration path).
 *
 * @returns {Promise<{flagged: boolean, categories: {category: string, score: number}[]}>}
 */
export const classifyContent = async ({ text = "", imageUrls = [] }) => {
  if (!ENABLED || (!text.trim() && imageUrls.length === 0)) {
    return { flagged: false, categories: [] };
  }

  try {
    if (PROVIDER !== "openai") {
      console.warn(
        `[aiModeration] unsupported AI_MODERATION_PROVIDER "${PROVIDER}", skipping AI classification`,
      );
      return { flagged: false, categories: [] };
    }

    const input = [];
    if (text.trim()) input.push({ type: "text", text });
    for (const url of imageUrls.slice(0, 4)) {
      input.push({ type: "image_url", image_url: { url } });
    }

    const result = await callOpenAIModeration(input);
    if (!result) return { flagged: false, categories: [] };

    const scores = result.category_scores || {};
    const flags = result.categories || {};
    const categories = Object.entries(scores)
      .filter(([category, score]) => {
        const threshold = category.includes("image")
          ? IMAGE_SCORE_THRESHOLD
          : TEXT_SCORE_THRESHOLD;
        return flags[category] || score >= threshold;
      })
      .map(([category, score]) => ({ category, score: Number(score.toFixed(4)) }))
      .sort((a, b) => b.score - a.score);

    return { flagged: categories.length > 0, categories };
  } catch (error) {
    console.error("[aiModeration] classification failed:", error.message);
    return { flagged: false, categories: [] };
  }
};

export const AI_MODERATION_CONFIG = {
  PROVIDER,
  ENABLED,
  TEXT_SCORE_THRESHOLD,
  IMAGE_SCORE_THRESHOLD,
};
