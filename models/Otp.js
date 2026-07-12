import mongoose from "mongoose";

const otpSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, index: true },
    otp: { type: String, required: true },
    payload: { type: mongoose.Schema.Types.Mixed },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

// TTL index: documents expire at `expiresAt`
otpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model("Otp", otpSchema);
