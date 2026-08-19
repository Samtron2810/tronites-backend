import User from "../models/User.js";
import { muteUser, unmuteUser, hasMuted } from "../services/muteService.js";
import { invalidateCache, invalidateFeedCache } from "../utils/redis.js";

export const getMuteStatus = async (req, res) => {
  try {
    const muted = await hasMuted(req.user._id, req.params.id);
    res.status(200).json({ muted });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const muteUserHandler = async (req, res) => {
  try {
    const targetId = req.params.id;
    if (targetId === req.user._id.toString()) {
      return res.status(400).json({ message: "You can't mute yourself" });
    }
    const target = await User.findById(targetId).select("_id");
    if (!target) return res.status(404).json({ message: "User not found" });

    await muteUser(req.user._id, targetId);

    // Muting changes what shows up in this user's own feed — the cached
    // feed page for this user specifically needs to drop the muted
    // account's posts on next read.
    invalidateFeedCache(req.user._id);

    res.status(200).json({ muted: true });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const unmuteUserHandler = async (req, res) => {
  try {
    const targetId = req.params.id;
    await unmuteUser(req.user._id, targetId);
    invalidateFeedCache(req.user._id);
    res.status(200).json({ muted: false });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
