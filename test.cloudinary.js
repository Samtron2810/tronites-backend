import dotenv from "dotenv";
dotenv.config();
import { v2 as cloudinary } from "cloudinary";
import fs from "fs";

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Create a tiny test image buffer (1x1 red pixel PNG)
const tinyPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

try {
  const result = await cloudinary.uploader.upload(
    `data:image/png;base64,${tinyPng.toString("base64")}`,
    { folder: "tronites_test" },
  );
  console.log("SUCCESS:", result.secure_url);
} catch (err) {
  console.log("ERROR NAME:", err.name);
  console.log("ERROR MESSAGE:", err.message);
  console.log("ERROR HTTP CODE:", err.http_code);
  console.log("FULL ERROR:", JSON.stringify(err, null, 2));
}
