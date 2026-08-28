import Notification from "../models/Notification.js";
import { groupNotifications } from "../utils/notificationGrouping.js";

// GET NOTIFICATIONS FOR LOGGED IN USER (paginated — was hard-capped at
// 20 with no way to see older notifications)
//
// Grouping happens after the page is fetched, not in the query — it
// collapses same-target like/commentLike/follow spam within THIS page
// into single display rows (see utils/notificationGrouping.js). This
// means `limit` still bounds how many raw Notification docs are read
// per request (bounded, predictable query cost); it does NOT bound how
// many rows the client renders — a page of 20 raw docs could collapse
// to as few as 1 row if they're all likes on the same post. hasMore/
// totalPages are computed from the raw (ungrouped) counts, since that's
// what pagination is actually walking through.
export const getNotifications = async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(
      Math.max(parseInt(req.query.limit, 10) || 20, 1),
      50,
    );
    const skip = (page - 1) * limit;

    const [notifications, totalNotifications] = await Promise.all([
      Notification.find({ recipient: req.user._id })
        .populate("sender", "name username profilePic")
        .populate("post", "text images")
        .populate("comment", "text")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      Notification.countDocuments({ recipient: req.user._id }),
    ]);

    res.status(200).json({
      notifications: groupNotifications(notifications),
      currentPage: page,
      totalPages: Math.ceil(totalNotifications / limit),
      hasMore: skip + notifications.length < totalNotifications,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// MARK ALL AS READ
export const markAllRead = async (req, res) => {
  try {
    await Notification.updateMany(
      { recipient: req.user._id, read: false },
      { read: true },
    );
    res.status(200).json({ message: "All notifications marked as read" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// GET UNREAD COUNT
export const getUnreadCount = async (req, res) => {
  try {
    const count = await Notification.countDocuments({
      recipient: req.user._id,
      read: false,
    });
    res.status(200).json({ count });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
