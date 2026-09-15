// Phase 7+ — auto alt-text generation for post images (accessibility +
// SEO). Runs fire-and-forget after a post with images is created (see
// postController.createPost), filling in altText ONLY for images the
// author left blank — never overwrites author-supplied alt text, and
// never delays or fails post creation itself.

const ENABLED =
  process.env.AI_ALT_TEXT_ENABLED !== "false" && !!process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_ALT_TEXT_MODEL || "gpt-4o-mini";
const REQUEST_TIMEOUT_MS = parseInt(process.env.AI_ALT_TEXT_TIMEOUT_MS || "10000", 10);
// Matches Post.images[].altText's schema maxlength (models/Post.js).
const MAX_ALT_TEXT_LENGTH = 200;

const withTimeout = (promise, ms) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Alt-text request timed out after ${ms}ms`)), ms),
    ),
  ]);

/**
 * Generates a short, literal alt-text description for one image URL.
 * Returns "" on any failure — the caller treats that as "leave blank",
 * never as a reason to fail anything upstream.
 */
export const generateAltText = async (imageUrl) => {
  if (!ENABLED) return "";

  try {
    const res = await withTimeout(
      fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 60,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text:
                    "Write a concise, literal alt-text description of this image for a " +
                    "screen-reader user — describe what's visibly in the frame, no " +
                    "speculation about context or intent. One sentence, under 200 " +
                    "characters, no leading 'Image of' / 'Photo of'.",
                },
                { type: "image_url", image_url: { url: imageUrl } },
              ],
            },
          ],
        }),
      }),
      REQUEST_TIMEOUT_MS,
    );
    if (!res.ok) throw new Error(`OpenAI vision API returned ${res.status}`);
    const data = await res.json();
    const altText = data.choices?.[0]?.message?.content?.trim() || "";
    return altText.slice(0, MAX_ALT_TEXT_LENGTH);
  } catch (error) {
    console.error("[altText] generation failed:", error.message);
    return "";
  }
};

/**
 * Fills in altText for any images in `images` (the Post.images array
 * shape: [{ url, altText }]) that are missing it, and persists the
 * result. No-op if every image already has author-supplied alt text.
 * Indices are matched positionally against the DB array — safe because
 * post images are immutable after creation (see models/Post.js).
 */
export const backfillAltText = async ({ postId, images }) => {
  if (!ENABLED || !Array.isArray(images) || images.length === 0) return;

  const missingIdx = images
    .map((img, i) => (img?.url && !img?.altText?.trim() ? i : -1))
    .filter((i) => i !== -1);
  if (!missingIdx.length) return;

  try {
    const generated = await Promise.all(
      missingIdx.map((i) => generateAltText(images[i].url)),
    );

    const setOps = {};
    missingIdx.forEach((idx, j) => {
      if (generated[j]) setOps[`images.${idx}.altText`] = generated[j];
    });
    if (Object.keys(setOps).length === 0) return;

    const { default: Post } = await import("../models/Post.js");
    await Post.updateOne({ _id: postId }, { $set: setOps });
  } catch (error) {
    console.error("[altText] backfill failed:", error.message);
  }
};
