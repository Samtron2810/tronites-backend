import {
  addModeratorNote,
  listModeratorNotes,
  deleteModeratorNote,
  getUserCaseHistory,
} from "../services/moderatorNoteService.js";
import { logAudit } from "../utils/auditLogger.js";

// POST /admin/users/:id/notes
export const addModeratorNoteHandler = async (req, res) => {
  try {
    const note = await addModeratorNote({
      userId: req.params.id,
      authorId: req.user._id,
      body: req.body.body,
    });
    res.status(201).json({ note });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

// GET /admin/users/:id/notes
export const listModeratorNotesHandler = async (req, res) => {
  try {
    const notes = await listModeratorNotes(req.params.id);
    res.status(200).json({ notes });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

// DELETE /admin/users/:id/notes/:noteId
export const deleteModeratorNoteHandler = async (req, res) => {
  try {
    await deleteModeratorNote({
      noteId: req.params.noteId,
      requesterId: req.user._id,
      requesterRole: req.user.role,
    });
    res.status(200).json({ message: "Note deleted." });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

// GET /admin/users/:id/case-history
export const getUserCaseHistoryHandler = async (req, res) => {
  try {
    const history = await getUserCaseHistory(req.params.id);
    res.status(200).json(history);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};
