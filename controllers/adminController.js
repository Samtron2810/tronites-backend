import User from "../models/User.js";
import { toAdminUserDTO } from "../dtos/userDTO.js";

// LIST/SEARCH USERS (admin only) — paginated, optional name/username/
// email search and role filter, for the admin panel's user picker.
export const listUsersForAdmin = async (req, res) => {
  try {
    const query = String(req.query.q || "").trim();
    const roleFilter = req.query.role; // "user" | "moderator" | "admin" | undefined
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);
    const skip = (page - 1) * limit;

    const filter = {};
    if (query.length >= 2) {
      filter.$or = [
        { name: { $regex: query, $options: "i" } },
        { username: { $regex: query, $options: "i" } },
        { email: { $regex: query, $options: "i" } },
      ];
    }
    if (["user", "moderator", "admin"].includes(roleFilter)) {
      filter.role = roleFilter;
    }

    const [users, totalUsers] = await Promise.all([
      User.find(filter)
        .select("name username email profilePic role createdAt")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      User.countDocuments(filter),
    ]);

    res.status(200).json({
      users: users.map(toAdminUserDTO),
      currentPage: page,
      totalPages: Math.ceil(totalUsers / limit),
      hasMore: skip + users.length < totalUsers,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// UPDATE A USER'S ROLE (admin only)
export const updateUserRole = async (req, res) => {
  try {
    const { role } = req.body;
    const targetId = req.params.id;

    // Prevent an admin from demoting themselves out of the only admin
    // account — a self-lockout with no remaining way to grant admin
    // back (per the model comment: role is otherwise only set directly
    // in the database).
    if (targetId === req.user._id.toString() && role !== "admin") {
      const otherAdmins = await User.countDocuments({
        role: "admin",
        _id: { $ne: req.user._id },
      });
      if (otherAdmins === 0) {
        return res.status(400).json({
          message: "You're the only admin — promote another admin before changing your own role.",
        });
      }
    }

    const user = await User.findByIdAndUpdate(
      targetId,
      { role },
      { new: true, runValidators: true },
    ).select("name username email profilePic role createdAt");

    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    res.status(200).json({ user: toAdminUserDTO(user) });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
