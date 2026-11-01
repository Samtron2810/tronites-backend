import mongoose from "mongoose";
import { CreatorPayout, CreatorBankAccount } from "../models/CreatorPayout.js";
import { initiateTransfer, verifyTransfer } from "../services/paystackService.js";
import {
  payoutReferenceFor,
  markPayoutPaid,
  markPayoutFailed,
} from "../services/payoutService.js";
import { logAudit } from "../utils/auditLogger.js";
import { invalidateCache } from "../utils/redis.js";

const STATUSES = ["pending", "processing", "paid", "failed"];

const auditTarget = (creator) => ({
  type: "user",
  ref: creator._id,
  snapshot: {
    name: creator.name,
    username: creator.username,
    role: creator.role,
  },
});

// GET /admin/payouts?status=&page=&limit=
export const listPayouts = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, parseInt(req.query.limit) || 20);
    const filter = STATUSES.includes(req.query.status)
      ? { status: req.query.status }
      : {};

    const [rows, total, summary] = await Promise.all([
      CreatorPayout.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate("creator", "name username profilePic role")
        .populate("reviewedBy", "name username")
        .lean(),
      CreatorPayout.countDocuments(filter),
      CreatorPayout.aggregate([
        {
          $group: {
            _id: "$status",
            count: { $sum: 1 },
            amountKobo: { $sum: "$amountKobo" },
          },
        },
      ]),
    ]);

    // Attach bank details (display-safe fields only) in one query.
    const creatorIds = rows.map((r) => r.creator?._id).filter(Boolean);
    const banks = await CreatorBankAccount.find({ creator: { $in: creatorIds } })
      .select("creator bankName accountName accountNumberLast4 paystackRecipientCode")
      .lean();
    const bankByCreator = new Map(banks.map((b) => [String(b.creator), b]));

    const payouts = rows.map((r) => {
      const b = bankByCreator.get(String(r.creator?._id));
      return {
        ...r,
        bank: b
          ? {
              bankName: b.bankName,
              accountName: b.accountName,
              accountNumberLast4: b.accountNumberLast4,
              transferReady: !!b.paystackRecipientCode,
            }
          : null,
      };
    });

    res.status(200).json({
      payouts,
      total,
      page,
      hasMore: page * limit < total,
      summary: Object.fromEntries(
        summary.map((s) => [s._id, { count: s.count, amountKobo: s.amountKobo }]),
      ),
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// POST /admin/payouts/:id/approve — starts the Paystack transfer.
export const approvePayout = async (req, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id))
    return res.status(404).json({ message: "Payout not found." });

  try {
    // Claim the payout atomically so two admins can't both send it.
    const reference = payoutReferenceFor(id);
    const payout = await CreatorPayout.findOneAndUpdate(
      { _id: id, status: "pending" },
      {
        $set: {
          status: "processing",
          paystackReference: reference,
          paystackStatus: "initiating",
          reviewedBy: req.user._id,
          reviewedAt: new Date(),
        },
      },
      { returnDocument: "after" },
    ).populate("creator", "name username role");

    if (!payout) {
      const exists = await CreatorPayout.exists({ _id: id });
      return res.status(exists ? 409 : 404).json({
        message: exists
          ? "This payout is no longer pending."
          : "Payout not found.",
      });
    }

    const revert = (message) =>
      CreatorPayout.updateOne(
        { _id: id, status: "processing" },
        {
          $set: {
            status: "pending",
            paystackReference: null,
            paystackStatus: "",
            reviewedBy: null,
            reviewedAt: null,
            failureReason: String(message).slice(0, 300),
          },
        },
      );

    const bank = await CreatorBankAccount.findOne({
      creator: payout.creator._id,
    }).lean();
    if (!bank?.paystackRecipientCode) {
      await revert("Creator must re-save bank details.");
      return res.status(422).json({
        message:
          "This creator's bank account isn't registered for transfers. Ask them to re-save their bank details, then approve again.",
      });
    }

    let transfer;
    try {
      transfer = await initiateTransfer({
        amountKobo: payout.amountKobo,
        recipientCode: bank.paystackRecipientCode,
        reference,
        reason: "Tronites creator payout",
      });
    } catch (e) {
      // Paystack refused before queuing anything (e.g. insufficient balance,
      // transfers not enabled) — put it back so it can be retried.
      await revert(e.message);
      return res.status(502).json({ message: e.message });
    }

    payout.paystackTransferCode = transfer.transfer_code || null;
    payout.paystackStatus = transfer.status || "pending";
    payout.failureReason = "";
    await payout.save();

    // Transfers can resolve immediately; otherwise the webhook (or the
    // admin "Check status" action) finishes the job.
    if (transfer.status === "success") await markPayoutPaid(reference);
    else if (transfer.status === "failed")
      await markPayoutFailed(reference, "failed", "Transfer failed.");

    invalidateCache(`creator-earnings:${payout.creator._id}`);
    logAudit({
      action: "creator_payout_approved",
      actor: req.user,
      req,
      target: auditTarget(payout.creator),
      detail: {
        payoutId: String(payout._id),
        amountNgn: payout.amountKobo / 100,
        transferCode: transfer.transfer_code || null,
      },
    });

    const fresh = await CreatorPayout.findById(id).lean();
    res.status(200).json({
      payout: fresh,
      ...(transfer.status === "otp"
        ? {
            warning:
              "Paystack is waiting for an OTP. Turn off transfer OTP in Paystack (Settings → Preferences) or approve it in the dashboard, then use Check status.",
          }
        : {}),
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// POST /admin/payouts/:id/reject  { reason } — pending only. The held
// balance is released because "failed" payouts don't count against it.
export const rejectPayout = async (req, res) => {
  const { id } = req.params;
  const reason = String(req.body?.reason || "").trim();
  if (!mongoose.isValidObjectId(id))
    return res.status(404).json({ message: "Payout not found." });
  if (reason.length < 3)
    return res.status(400).json({ message: "Give a reason for rejecting." });

  try {
    const payout = await CreatorPayout.findOneAndUpdate(
      { _id: id, status: "pending" },
      {
        $set: {
          status: "failed",
          paystackStatus: "rejected",
          failureReason: `Rejected: ${reason}`.slice(0, 300),
          resolvedAt: new Date(),
          reviewedBy: req.user._id,
          reviewedAt: new Date(),
        },
      },
      { returnDocument: "after" },
    ).populate("creator", "name username role");

    if (!payout) {
      const exists = await CreatorPayout.exists({ _id: id });
      return res.status(exists ? 409 : 404).json({
        message: exists
          ? "Only pending payouts can be rejected."
          : "Payout not found.",
      });
    }

    invalidateCache(`creator-earnings:${payout.creator._id}`);
    logAudit({
      action: "creator_payout_rejected",
      actor: req.user,
      req,
      target: auditTarget(payout.creator),
      detail: {
        payoutId: String(payout._id),
        amountNgn: payout.amountKobo / 100,
        reason,
      },
    });

    res.status(200).json({ payout });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// POST /admin/payouts/:id/sync — asks Paystack for the transfer's state.
// Fallback for when the transfer webhook isn't configured or was missed.
export const syncPayout = async (req, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id))
    return res.status(404).json({ message: "Payout not found." });

  try {
    const payout = await CreatorPayout.findById(id);
    if (!payout) return res.status(404).json({ message: "Payout not found." });
    if (payout.status !== "processing" || !payout.paystackReference)
      return res.status(409).json({ message: "This payout isn't processing." });

    const transfer = await verifyTransfer(payout.paystackReference);

    if (transfer.status === "success") {
      await markPayoutPaid(payout.paystackReference);
    } else if (["failed", "reversed"].includes(transfer.status)) {
      await markPayoutFailed(
        payout.paystackReference,
        transfer.status,
        transfer.reason || `Transfer ${transfer.status}.`,
      );
    } else {
      await CreatorPayout.updateOne(
        { _id: id, status: "processing" },
        { $set: { paystackStatus: transfer.status || "pending" } },
      );
    }

    res.status(200).json({ payout: await CreatorPayout.findById(id).lean() });
  } catch (error) {
    res.status(502).json({ message: error.message });
  }
};
