CREATE TABLE IF NOT EXISTS works (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  cn TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'corporate',
  detail TEXT NOT NULL DEFAULT '',
  image_key TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_works_sort ON works(sort_order);
CREATE INDEX IF NOT EXISTS idx_works_category ON works(category);
