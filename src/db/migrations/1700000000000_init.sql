-- Up Migration

CREATE TYPE asset_status AS ENUM ('pending','downloading','stored','failed','unavailable');
CREATE TYPE sync_source  AS ENUM ('top','recent');
CREATE TYPE run_status   AS ENUM ('running','succeeded','failed');

CREATE TABLE hashtags (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ig_hashtag_id  TEXT        NOT NULL UNIQUE,
  name           TEXT        NOT NULL UNIQUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE media (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ig_media_id       TEXT         NOT NULL UNIQUE,
  -- TEXT, not an enum: an unrecognised Meta media type must not fail the insert.
  media_type        TEXT         NOT NULL,
  caption           TEXT,
  permalink         TEXT         NOT NULL,
  ig_timestamp      TIMESTAMPTZ  NOT NULL,
  like_count        INTEGER,
  comments_count    INTEGER,
  -- Expiring signed CDN URL. Provenance only; never served to clients.
  source_media_url  TEXT,
  storage_key       TEXT,
  content_type      TEXT,
  storage_bytes     BIGINT,
  asset_status      asset_status NOT NULL DEFAULT 'pending',
  asset_error       TEXT,
  asset_attempts    SMALLINT     NOT NULL DEFAULT 0,
  raw               JSONB        NOT NULL,
  first_seen_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  last_seen_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Exactly matches the read API's ORDER BY.
CREATE INDEX idx_media_feed ON media (ig_timestamp DESC, id DESC);
-- Partial: only rows still needing asset work.
CREATE INDEX idx_media_asset_pending ON media (asset_status)
  WHERE asset_status IN ('pending','failed');

CREATE TABLE hashtag_media (
  hashtag_id     BIGINT      NOT NULL REFERENCES hashtags(id) ON DELETE CASCADE,
  media_id       BIGINT      NOT NULL REFERENCES media(id)    ON DELETE CASCADE,
  source         sync_source NOT NULL,
  first_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (hashtag_id, media_id, source)
);

CREATE INDEX idx_hashtag_media_hashtag ON hashtag_media (hashtag_id);
CREATE INDEX idx_hashtag_media_media   ON hashtag_media (media_id);

CREATE TABLE sync_runs (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  hashtag_id     BIGINT      NOT NULL REFERENCES hashtags(id) ON DELETE CASCADE,
  source         sync_source NOT NULL,
  status         run_status  NOT NULL DEFAULT 'running',
  pages_fetched  INTEGER     NOT NULL DEFAULT 0,
  items_seen     INTEGER     NOT NULL DEFAULT 0,
  items_new      INTEGER     NOT NULL DEFAULT 0,
  error          TEXT,
  started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at    TIMESTAMPTZ
);

CREATE INDEX idx_sync_runs_lookup ON sync_runs (hashtag_id, source, started_at DESC);

INSERT INTO hashtags (ig_hashtag_id, name)
VALUES ('17843758702042126', 'matcha')
ON CONFLICT (ig_hashtag_id) DO NOTHING;

-- Down Migration

DROP TABLE IF EXISTS sync_runs;
DROP TABLE IF EXISTS hashtag_media;
DROP TABLE IF EXISTS media;
DROP TABLE IF EXISTS hashtags;
DROP TYPE IF EXISTS run_status;
DROP TYPE IF EXISTS sync_source;
DROP TYPE IF EXISTS asset_status;
