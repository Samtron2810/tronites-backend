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
    const { note, target } = await addModeratorNote({
      userId: req.params.id,
      authorId: req.user._id,
      body: req.body.body,
    });

    // Phase 7 - notes are moderator-only free text, so the audit entry is
    // the only place the content is visible outside the note itself.
    // Written AFTER the create succeeded, matching every other call site
    // (logAudit is fire-and-forget - see utils/auditLogger.js).
    logAudit({
      action: "moderator_note_added",
      actor: req.user,
      req,
      target: {
        type: "user",
        ref: target._id,
        snapshot: { name: target.name, username: target.username },
      },
      detail: { noteId: note._id, body: note.body },
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
    const { note, target } = await deleteModeratorNote({
      noteId: req.params.noteId,
      requesterId: req.user._id,
      requesterRole: req.user.role,
    });

    // Mirrors moderator_note_added: the deleted body is preserved in the
    // trail because nothing else on the system still holds it.
    logAudit({
      action: "moderator_note_deleted",
      actor: req.user,
      req,
      target: {
        type: "user",
        ref: target ? target._id : note.user,
        snapshot: {
          name: target ? target.name : "",
          username: target ? target.username : null,
        },
      },
      detail: { noteId: note._id, body: note.body },
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
