import { Worker } from "bullmq";
import cloudinary from "../utils/cloudinary.js";

const connection = {
  url: process.env.REDIS_URL || "redis://localhost:6379",
};

// This worker runs the actual Cloudinary upload. It can live in the same
// process as the API (simplest — what we wire up here) or be split into
// its own process/deploy later if upload volume grows enough to need
// dedicated worker machines. Splitting it out is just moving where
// `startImageUploadWorker()` gets called from — no other code changes.
//
// concurrency: how many uploads this worker handles at once. 5 is a
// reasonable default — high enough to not create a backlog under normal
// load, low enough not to saturate outbound bandwidth or hit Cloudinary
// rate limits.
export const startImageUploadWorker = () => {
  const worker = new Worker(
    "image-upload",
    async (job) => {
      const { base64Data, folder, transformation } = job.data;

      const result = await cloudinary.uploader.upload(base64Data, {
        folder,
        ...(transformation ? { transformation } : {}),
      });

      return { secureUrl: result.secure_url, publicId: result.public_id };
    },
    {
      connection,
      concurrency: 5,
    },
  );

  worker.on("failed", (job, err) => {
    console.error(`Image upload job ${job?.id} failed:`, err.message);
  });

  worker.on("error", (err) => {
    console.error("Image upload worker error:", err.message);
  });

  console.log("Image upload worker started");
  return worker;
};
