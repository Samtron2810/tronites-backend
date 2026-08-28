import Session from "../models/Session.js";
import {
  revokeAllSessionsExcept,
  hashPresentedRefreshToken,
} from "../utils/tokens.js";
import { parseDeviceLabel, parseDeviceType } from "../utils/deviceLabel.js";

const REFRESH_COOKIE_NAME = "refreshToken";

// GET /api/users/me/sessions — every live session for the caller,
// newest-active first, with the caller's own session flagged so the
// frontend can pin/label it "This device" and disable its own revoke
// button.
export const listSessions = async (req, res) => {
  try {
    const currentHash = hashPresentedRefreshToken(
      req.cookies[REFRESH_COOKIE_NAME],
    );

    const sessions = await Session.find({ user: req.user._id })
      .sort({ lastUsedAt: -1 })
      .lean();

    const dto = sessions.map((s) => ({
      id: s._id,
      device: parseDeviceLabel(s.userAgent),
      deviceType: parseDeviceType(s.userAgent),
      ip: s.ip || null,
      isCurrent: currentHash != null && s.tokenHash === currentHash,
      lastUsedAt: s.lastUsedAt,
      createdAt: s.createdAt,
    }));

    // Current device first regardless of lastUsedAt ordering — it's the
    // one the user is looking at right now, so it belongs at the top.
    dto.sort((a, b) => (b.isCurrent ? 1 : 0) - (a.isCurrent ? 1 : 0));

    res.status(200).json(dto);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// DELETE /api/users/me/sessions/:id — revoke one device. Scoped to
// req.user._id in the filter so a user can never revoke someone else's
// session by guessing an id. Refuses to let the current session revoke
// itself through this route — that's what /logout is for, and doing it
// here would 401 the very request that asked for it.
export const revokeSessionById = async (req, res) => {
  try {
    const currentHash = hashPresentedRefreshToken(
      req.cookies[REFRESH_COOKIE_NAME],
    );

    const session = await Session.findOne({
      _id: req.params.id,
      user: req.user._id,
    });

    if (!session) {
      return res.status(404).json({ message: "Session not found." });
    }

    if (currentHash && session.tokenHash === currentHash) {
      return res.status(400).json({
        message: "Use logout to end your current session.",
      });
    }

    await session.deleteOne();
    res.status(200).json({ message: "Session revoked." });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// DELETE /api/users/me/sessions — "Log out other devices". Keeps the
// caller's own session alive.
export const revokeOtherSessions = async (req, res) => {
  try {
    const count = await revokeAllSessionsExcept(
      req.user._id,
      req.cookies[REFRESH_COOKIE_NAME],
    );
    res.status(200).json({ message: "Other sessions revoked.", count });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
