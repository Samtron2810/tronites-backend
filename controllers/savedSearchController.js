import SavedSearch from "../models/SavedSearch.js";

// History rows auto-prune past this count per user — a running log, not
// an archive. Saved searches (type: "saved") are never pruned; only the
// user deleting one removes it.
const MAX_HISTORY_PER_USER = 20;

// LOG A SEARCH — called by the client after a search actually runs
// (debounced, not on every keystroke) to append to the caller's
// history. Upserts on identical (scope, query, filters) so repeating
// the same search bumps it to the top instead of duplicating it.
export const logSearchHistory = async (req, res) => {
  try {
    const { scope, query = "", filters = {} } = req.body || {};
    if (!["posts", "comments", "messages", "users"].includes(scope)) {
      return res.status(400).json({ message: "Invalid search scope." });
    }
    const trimmedQuery = String(query).trim().slice(0, 280);
    const cleanFilters = {
      from: filters.from ? String(filters.from).trim().slice(0, 20) : null,
      startDate: filters.startDate ? new Date(filters.startDate) : null,
      endDate: filters.endDate ? new Date(filters.endDate) : null,
      hasMedia: typeof filters.hasMedia === "boolean" ? filters.hasMedia : null,
      minLikes: Number.isFinite(filters.minLikes) ? filters.minLikes : null,
    };

    // Nothing meaningful to log (empty query, no filters) — skip
    // silently rather than littering history with blank entries.
    const hasFilters = Object.values(cleanFilters).some((v) => v !== null);
    if (!trimmedQuery && !hasFilters) {
      return res.status(200).json({ logged: false });
    }

    await SavedSearch.findOneAndUpdate(
      {
        user: req.user._id,
        type: "history",
        scope,
        query: trimmedQuery,
        "filters.from": cleanFilters.from,
        "filters.hasMedia": cleanFilters.hasMedia,
        "filters.minLikes": cleanFilters.minLikes,
      },
      {
        user: req.user._id,
        type: "history",
        scope,
        query: trimmedQuery,
        filters: cleanFilters,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    // Trim to MAX_HISTORY_PER_USER — cheap enough to run on every log
    // call since history rows per user stay small and this is a
    // low-frequency, debounced write path.
    const excess = await SavedSearch.find({ user: req.user._id, type: "history" })
      .sort({ createdAt: -1 })
      .skip(MAX_HISTORY_PER_USER)
      .select("_id");
    if (excess.length) {
      await SavedSearch.deleteMany({ _id: { $in: excess.map((d) => d._id) } });
    }

    res.status(200).json({ logged: true });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// GET /search/history?scope=posts — newest first, capped list.
export const getSearchHistory = async (req, res) => {
  try {
    const scope = req.query.scope;
    const filter = { user: req.user._id, type: "history" };
    if (scope) filter.scope = scope;

    const history = await SavedSearch.find(filter)
      .sort({ createdAt: -1 })
      .limit(MAX_HISTORY_PER_USER);

    res.status(200).json({ history });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const deleteSearchHistoryEntry = async (req, res) => {
  try {
    await SavedSearch.deleteOne({
      _id: req.params.id,
      user: req.user._id,
      type: "history",
    });
    res.status(200).json({ deleted: true });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const clearSearchHistory = async (req, res) => {
  try {
    const filter = { user: req.user._id, type: "history" };
    if (req.query.scope) filter.scope = req.query.scope;
    await SavedSearch.deleteMany(filter);
    res.status(200).json({ cleared: true });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// SAVE A SEARCH — explicit user action (a star/bookmark on a search),
// distinct from the auto-logged history above. No upsert-merge here:
// saving the "same" search twice with a different label is allowed
// (the label is the point of a saved search), so each save is its own
// row.
export const saveSearch = async (req, res) => {
  try {
    const { scope, query = "", filters = {}, label = "" } = req.body || {};
    if (!["posts", "comments", "messages", "users"].includes(scope)) {
      return res.status(400).json({ message: "Invalid search scope." });
    }

    const savedCount = await SavedSearch.countDocuments({
      user: req.user._id,
      type: "saved",
    });
    // A generous but real ceiling — prevents unbounded growth from a
    // scripted/abusive client without constraining any real usage
    // pattern (nobody manually saves 100 distinct searches).
    if (savedCount >= 100) {
      return res.status(400).json({ message: "Saved search limit reached (100)." });
    }

    const saved = await SavedSearch.create({
      user: req.user._id,
      type: "saved",
      scope,
      query: String(query).trim().slice(0, 280),
      label: String(label).trim().slice(0, 60),
      filters: {
        from: filters.from ? String(filters.from).trim().slice(0, 20) : null,
        startDate: filters.startDate ? new Date(filters.startDate) : null,
        endDate: filters.endDate ? new Date(filters.endDate) : null,
        hasMedia: typeof filters.hasMedia === "boolean" ? filters.hasMedia : null,
        minLikes: Number.isFinite(filters.minLikes) ? filters.minLikes : null,
      },
    });

    res.status(201).json({ savedSearch: saved });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getSavedSearches = async (req, res) => {
  try {
    const scope = req.query.scope;
    const filter = { user: req.user._id, type: "saved" };
    if (scope) filter.scope = scope;

    const savedSearches = await SavedSearch.find(filter).sort({ createdAt: -1 });
    res.status(200).json({ savedSearches });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const deleteSavedSearch = async (req, res) => {
  try {
    const result = await SavedSearch.deleteOne({
      _id: req.params.id,
      user: req.user._id,
      type: "saved",
    });
    if (result.deletedCount === 0) {
      return res.status(404).json({ message: "Saved search not found." });
    }
    res.status(200).json({ deleted: true });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
