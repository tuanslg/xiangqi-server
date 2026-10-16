CREATE TABLE games (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          text NOT NULL,
  tc            text NOT NULL,
  red_name      text NOT NULL,
  black_name    text NOT NULL,
  red_user_id   uuid REFERENCES users (id) ON DELETE SET NULL,
  black_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  winner        text CHECK (winner IN ('red', 'black')), -- NULL = draw
  reason        text NOT NULL,
  moves         text NOT NULL, -- space separated UCI moves from the standard start position
  started_at    timestamptz NOT NULL,
  finished_at   timestamptz NOT NULL
);

CREATE INDEX games_red_user_idx ON games (red_user_id, finished_at DESC);
CREATE INDEX games_black_user_idx ON games (black_user_id, finished_at DESC);
