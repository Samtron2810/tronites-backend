import Comment from "../models/Comment.js";
import Post from "../models/Post.js";

// ADD COMMENT
export const addComment = async (req, res) => {
  try {
    const { text } = req.body;

    const post = await Post.findById(req.params.id);

    if (!post) {
      return res.status(404).json({
        message: "Post not found",
      });
    }

    const comment = await Comment.create({
      post: req.params.id,
      user: req.user._id,
      text,
    });

    post.commentsCount += 1;
    await post.save();

    const populatedComment = await comment.populate("user", "name profilePic");

    res.status(201).json(populatedComment);
  } catch (error) {
    res.status(500).json({
      message: error.message,
    });
  }
};

// GET COMMENTS
export const getComments = async (req, res) => {
  try {
    const comments = await Comment.find({
      post: req.params.id,
    })
      .populate("user", "name profilePic")
      .sort({ createdAt: -1 });

    res.status(200).json(comments);
  } catch (error) {
    res.status(500).json({
      message: error.message,
    });
  }
};
