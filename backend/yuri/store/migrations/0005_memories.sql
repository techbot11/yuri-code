-- One thing Yuri remembers. Replaces ~/Yuri/memory/*.md as the READ path; the
-- files themselves are never touched (spec §8) and are imported once by
-- yuri/services/legacy_memory.py, which cannot live here because SQL cannot
-- read a directory.
CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  kind TEXT NOT NULL,
  subject TEXT NOT NULL,
  source TEXT NOT NULL,
  origin TEXT NOT NULL,
  -- No REFERENCES memories(id): a superseding row can be written in the same
  -- transaction as the row it supersedes, and the mission-delete regression
  -- (Phase 7) is a standing reminder that a foreign key nobody cascades is a
  -- 500 waiting to happen. Integrity here is one service's job, not sqlite's.
  superseded_by TEXT,
  pinned INTEGER NOT NULL DEFAULT 0,
  -- 768 float32 little-endian, or NULL until the background embedder runs.
  embedding BLOB,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- The core tier's query: current rows, by kind, by subject (spec §4.1).
CREATE INDEX memories_current ON memories(kind, subject) WHERE superseded_by IS NULL;
-- The background embedder's query.
CREATE INDEX memories_unembedded ON memories(created_at)
  WHERE embedding IS NULL AND superseded_by IS NULL;
-- The dedup no-op's lookup (spec §5.4).
CREATE INDEX memories_body ON memories(body) WHERE superseded_by IS NULL;
-- The panel's superseded-history view.
CREATE INDEX memories_superseded ON memories(superseded_by);
