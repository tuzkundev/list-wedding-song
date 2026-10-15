CREATE TABLE IF NOT EXISTS playlists_state (
  id TEXT PRIMARY KEY,
  text_content TEXT NOT NULL DEFAULT '',
  playlist_json TEXT,
  rights_accepted INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS cloud_assets (
  asset_id TEXT PRIMARY KEY,
  video_id TEXT NOT NULL UNIQUE,
  duration_seconds REAL NOT NULL,
  peaks_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cloud_assets_video_id ON cloud_assets(video_id);

CREATE TABLE IF NOT EXISTS search_cache (
  query TEXT PRIMARY KEY,
  candidates_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
