-- The schema of JAVA-BACKEND.md §7.1, with the choices of backend-java/STATO.md:
--   * ids are made by the program (Ids: UUIDv7, users UUIDv4), never by Postgres;
--   * the public id of a user is usr_ + their 16 bytes, of a chat chat_ + its 16 bytes,
--     of an event chat event:<event id>: no public_id columns;
--   * places are two numbers (latitude, longitude) and a generated geography for PostGIS:
--     the program reads and writes numbers, the GiST index works on the generated column;
--   * no DEFAULT now(): the time of the application is always given by the program
--     (InstantSource), so one clock decides, and tests can move it.
-- Foreign keys with ON DELETE CASCADE have an index on their column, or every delete
-- would read the whole table. This file never changes once applied: changes are new files.

CREATE EXTENSION IF NOT EXISTS postgis;

-- people

CREATE TABLE users (
  id             uuid PRIMARY KEY,
  sub            text NOT NULL UNIQUE,
  username       text NOT NULL UNIQUE
                 CHECK (username ~ '^[a-z0-9._]{3,30}$' AND username !~ '(^\.|\.$|\.\.)'),
  name           text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 30),
  email          text,
  named          boolean NOT NULL DEFAULT false,
  last_active_on date NOT NULL,                                          -- C3-bis: inactive accounts
  bio            text NOT NULL DEFAULT '' CHECK (char_length(bio) <= 200),
  picture_key    text,
  style          jsonb NOT NULL,
  settings       jsonb NOT NULL,
  story          jsonb NOT NULL,
  story_audience text NOT NULL DEFAULT 'connections' CHECK (story_audience IN ('connections', 'everyone')),
  avatar         jsonb,
  avatar_version int NOT NULL DEFAULT 0 CHECK (avatar_version >= 0),
  map_avatar_key text,
  suspended_at   timestamptz,
  created_at     timestamptz NOT NULL
);

CREATE TABLE connections (                                               -- two rows a pair
  user_id  uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  other_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  since    timestamptz NOT NULL,
  place    text,
  PRIMARY KEY (user_id, other_id),
  CHECK (user_id <> other_id)
);
CREATE INDEX ON connections (other_id);

CREATE TABLE disconnected_pairs (                                        -- a < b
  a uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  b uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  PRIMARY KEY (a, b),
  CHECK (a < b)
);
CREATE INDEX ON disconnected_pairs (b);

CREATE TABLE blocks (
  blocker uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  blocked uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  since   timestamptz NOT NULL,
  PRIMARY KEY (blocker, blocked),
  CHECK (blocker <> blocked)
);
CREATE INDEX ON blocks (blocked);                                        -- looked up both ways

CREATE TABLE story_hidden (
  user_id   uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  moment_id text NOT NULL CHECK (char_length(moment_id) <= 64),
  PRIMARY KEY (user_id, moment_id)
);

CREATE TABLE push_tokens (
  token    text PRIMARY KEY CHECK (char_length(token) BETWEEN 1 AND 256),
  user_id  uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  platform text NOT NULL CHECK (platform IN ('ios', 'android')),
  added_at timestamptz NOT NULL                                          -- at most 10: the oldest goes
);
CREATE INDEX ON push_tokens (user_id, added_at);

CREATE TABLE consents (
  user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  kind    text NOT NULL,
  version int NOT NULL,
  mode    text,
  at      timestamptz NOT NULL
);
CREATE INDEX ON consents (user_id, kind, at);

-- events

CREATE TABLE events (
  id                    uuid PRIMARY KEY,
  creator_id            uuid NOT NULL REFERENCES users,                  -- DELETE /me takes the events of who goes first
  title                 text NOT NULL,
  description           text NOT NULL DEFAULT '',
  categories            text[] NOT NULL DEFAULT '{}',
  latitude              double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude             double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  location              geography(Point, 4326)
                        GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography) STORED,
  address               text,
  starts_at             timestamptz NOT NULL,
  ends_at               timestamptz NOT NULL,
  created_at            timestamptz NOT NULL,
  modified_at           timestamptz,
  cancelled_at          timestamptz,
  links                 text,
  flash                 boolean NOT NULL DEFAULT false,
  spots_needed          int NOT NULL DEFAULT 0 CHECK (spots_needed >= 0),
  theme                 jsonb,                                           -- six fixed fields, or NULL: §16, Il tema di un evento
  image_keys            text[] NOT NULL DEFAULT '{}',
  reach                 int NOT NULL CHECK (reach BETWEEN 100 AND 800),
  follower_count        int NOT NULL DEFAULT 0 CHECK (follower_count >= 0),
  guest_count           int NOT NULL DEFAULT 0 CHECK (guest_count >= 0),
  photo_count           int NOT NULL DEFAULT 0 CHECK (photo_count >= 0),
  rating_count          int NOT NULL DEFAULT 0 CHECK (rating_count >= 0),
  rating_sum            double precision NOT NULL DEFAULT 0,             -- a rating may have decimals
  starting_notified_for timestamptz,                                     -- the start "about to begin" went for; moved, it goes again
  CHECK (ends_at > starts_at)
);
CREATE INDEX events_location ON events USING gist (location) WHERE cancelled_at IS NULL;
CREATE INDEX ON events (creator_id, starts_at DESC);
CREATE INDEX ON events (ends_at);                                        -- retention, chats to close
CREATE INDEX ON events (starts_at) WHERE cancelled_at IS NULL;           -- reminders

CREATE TABLE event_attendees (
  event_id  uuid NOT NULL REFERENCES events ON DELETE CASCADE,
  user_id   uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  joined_at timestamptz NOT NULL,
  public    boolean NOT NULL,                                            -- story_audience, copied
  PRIMARY KEY (event_id, user_id)
);
CREATE INDEX ON event_attendees (user_id, joined_at DESC);               -- story, Saved
CREATE INDEX ON event_attendees (event_id, joined_at) WHERE public;      -- "Who's in" for strangers

CREATE TABLE event_saved (
  user_id  uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  event_id uuid NOT NULL REFERENCES events ON DELETE CASCADE,
  since    timestamptz NOT NULL,
  PRIMARY KEY (user_id, event_id)
);
CREATE INDEX ON event_saved (event_id);

CREATE TABLE saved_hidden (                                              -- out of the lists: events cancelled before they began only
  user_id  uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  event_id uuid NOT NULL REFERENCES events ON DELETE CASCADE,
  PRIMARY KEY (user_id, event_id)
);
CREATE INDEX ON saved_hidden (event_id);

CREATE TABLE event_ratings (
  id       uuid NOT NULL UNIQUE,                                         -- Rating.id of API.md
  event_id uuid NOT NULL REFERENCES events ON DELETE CASCADE,
  user_id  uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  rating   real NOT NULL,
  comment  text,
  date     timestamptz NOT NULL,
  modified timestamptz,
  PRIMARY KEY (event_id, user_id)
);
CREATE INDEX ON event_ratings (user_id, date DESC);                      -- story, deletion

CREATE TABLE event_photos (
  id         uuid PRIMARY KEY,
  event_id   uuid NOT NULL REFERENCES events ON DELETE CASCADE,
  author_id  uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  key        text NOT NULL,
  thumb_key  text NOT NULL,
  width      int NOT NULL,
  height     int NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE INDEX ON event_photos (event_id, id DESC);
CREATE INDEX ON event_photos (event_id, author_id);                      -- how many they added
CREATE INDEX ON event_photos (author_id, created_at DESC);               -- limits, deletion

CREATE TABLE event_bans (
  event_id uuid NOT NULL REFERENCES events ON DELETE CASCADE,
  user_id  uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  PRIMARY KEY (event_id, user_id)
);
CREATE INDEX ON event_bans (user_id);

CREATE TABLE album_settings (
  event_id     uuid PRIMARY KEY REFERENCES events ON DELETE CASCADE,
  who_can_post text NOT NULL,
  contributors uuid[] NOT NULL DEFAULT '{}'
);

-- chats: one shape for direct chats, groups and events

CREATE TABLE chats (
  id           uuid PRIMARY KEY,
  kind         text NOT NULL CHECK (kind IN ('direct', 'group', 'event')),
  title        text,
  color        text,
  picture_key  text,
  owner_id     uuid REFERENCES users ON DELETE SET NULL,
  event_id     uuid UNIQUE REFERENCES events ON DELETE CASCADE,
  read_only    boolean NOT NULL DEFAULT false,
  opened_by    uuid,                                                     -- direct: who opened it; seen by them alone until someone writes (§20)
  seq          bigint NOT NULL DEFAULT 0,                                -- the last message: gives the order
  counter      bigint NOT NULL DEFAULT 0,                                -- messages that count as unread
  member_count int NOT NULL DEFAULT 0 CHECK (member_count >= 0),
  last_message jsonb,
  last_at      timestamptz,
  large        boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL
) WITH (fillfactor = 70);                                                -- HOT updates: never an index on seq, counter, last_*
CREATE INDEX ON chats (owner_id) WHERE owner_id IS NOT NULL;             -- groups owned (limit 50)

CREATE TABLE chat_members (
  chat_id       uuid NOT NULL REFERENCES chats ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  role          text NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
  read_counter  bigint NOT NULL DEFAULT 0,
  read_at       timestamptz,
  muted_until   timestamptz,
  muted_forever boolean NOT NULL DEFAULT false,
  joined_seq    bigint NOT NULL DEFAULT 0,                               -- groups: sees from this message on; events: 0
  joined_at     timestamptz NOT NULL,
  PRIMARY KEY (chat_id, user_id)
) WITH (fillfactor = 80);
CREATE INDEX ON chat_members (user_id, chat_id);                         -- the inbox

CREATE TABLE direct_chats (                                              -- a < b
  a       uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  b       uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  chat_id uuid NOT NULL REFERENCES chats ON DELETE CASCADE,
  PRIMARY KEY (a, b),
  CHECK (a < b)
);
CREATE INDEX ON direct_chats (b);
CREATE INDEX ON direct_chats (chat_id);

-- Without foreign keys: chats and accounts go at once, their messages in batches (§18)
CREATE TABLE messages (
  chat_id    uuid NOT NULL,
  seq        bigint NOT NULL,
  id         uuid NOT NULL,
  counter    bigint NOT NULL,
  at         timestamptz NOT NULL,
  sender     uuid,                                                       -- NULL: a system message without author
  text       text NOT NULL DEFAULT '',
  client_id  text,
  system     boolean NOT NULL DEFAULT false,
  deleted_at timestamptz,                                                -- text emptied, the place stays
  poll       jsonb,
  PRIMARY KEY (chat_id, seq),
  UNIQUE (chat_id, id)
) PARTITION BY HASH (chat_id);
DO $$ BEGIN
  FOR i IN 0..63 LOOP
    EXECUTE format('CREATE TABLE messages_%s PARTITION OF messages FOR VALUES WITH (MODULUS 64, REMAINDER %s)', i, i);
  END LOOP;
END $$;
CREATE INDEX ON messages (sender);                                       -- account deletion

CREATE TABLE chat_pins (
  chat_id    uuid NOT NULL REFERENCES chats ON DELETE CASCADE,
  message_id uuid NOT NULL,
  pinned_at  timestamptz NOT NULL,
  PRIMARY KEY (chat_id, message_id)
);

CREATE TABLE poll_votes (
  chat_id    uuid NOT NULL REFERENCES chats ON DELETE CASCADE,
  message_id uuid NOT NULL,
  user_id    uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  option_ids text[] NOT NULL,
  PRIMARY KEY (message_id, user_id)
);
CREATE INDEX ON poll_votes (user_id);                                    -- deletion
CREATE INDEX ON poll_votes (chat_id);

CREATE TABLE sent_messages (                                             -- sending twice gives one message, 24 h
  chat_id    uuid NOT NULL,
  sender     uuid NOT NULL,
  client_id  text NOT NULL CHECK (char_length(client_id) <= 64),
  message_id uuid NOT NULL,
  at         timestamptz NOT NULL,
  PRIMARY KEY (chat_id, sender, client_id)
);
CREATE INDEX ON sent_messages (at);                                      -- cleaning in batches

-- money

CREATE TABLE wallets (
  user_id       uuid PRIMARY KEY REFERENCES users ON DELETE CASCADE,
  balance       int NOT NULL DEFAULT 0,                                  -- may go below zero (a purchase refunded)
  account_token uuid NOT NULL UNIQUE
);

CREATE TABLE wallet_entries (                                            -- added only, never changed
  id         uuid PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  at         timestamptz NOT NULL,
  amount     int NOT NULL,
  kind       text NOT NULL,
  event_id   uuid,
  product_id text,
  store_key  text                                                        -- a refund: finds the purchase
);
CREATE INDEX ON wallet_entries (user_id, at DESC);
CREATE INDEX ON wallet_entries (store_key) WHERE store_key IS NOT NULL;

CREATE TABLE store_transactions (                                        -- stays after deletion: never credited twice
  key     text PRIMARY KEY,
  user_id uuid                                                           -- NULL after the account is deleted
);

CREATE TABLE promotions (
  event_id   uuid PRIMARY KEY REFERENCES events ON DELETE CASCADE,
  latitude   double precision NOT NULL,
  longitude  double precision NOT NULL,
  location   geography(Point, 4326)
             GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography) STORED,
  radius     int NOT NULL,
  daily      int NOT NULL,
  paid_rate  int NOT NULL,                                               -- the price the time already paid was paid at
  started_at timestamptz NOT NULL,
  paid_until timestamptz NOT NULL,
  status     text NOT NULL CHECK (status IN ('live', 'paused', 'stopped', 'ended')),
  charged    int NOT NULL DEFAULT 0 CHECK (charged >= 0),
  refunded   int NOT NULL DEFAULT 0 CHECK (refunded >= 0),
  CHECK (refunded <= charged)
);
CREATE INDEX promotions_location ON promotions USING gist (location) WHERE status IN ('live', 'stopped');
CREATE INDEX ON promotions (paid_until) WHERE status IN ('live', 'stopped');

-- the rest

CREATE TABLE notifications (
  id       uuid PRIMARY KEY,
  user_id  uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  kind     text NOT NULL,
  event_id uuid,
  at       timestamptz NOT NULL,
  actors   uuid[] NOT NULL DEFAULT '{}',
  count    int NOT NULL DEFAULT 1,
  data     jsonb,
  read     boolean NOT NULL DEFAULT false
);
CREATE INDEX ON notifications (user_id, at DESC);                        -- gathering: the last alike unread within 24 h, FOR UPDATE
CREATE INDEX ON notifications USING gin (actors);                        -- a deleted account leaves the others' notifications
CREATE INDEX ON notifications (at);                                      -- cleaning past 60 days
CREATE INDEX ON notifications (user_id) WHERE NOT read;                  -- the unread count of every GET /me

CREATE TABLE export_tokens (                                             -- once only: DELETE … RETURNING
  token_hash bytea PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);
CREATE INDEX ON export_tokens (expires_at);
CREATE INDEX ON export_tokens (user_id);

CREATE TABLE erased_accounts (
  sub text PRIMARY KEY,
  at  timestamptz NOT NULL
);
CREATE INDEX ON erased_accounts (at);

CREATE TABLE uploads (
  id          uuid PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  purpose     text NOT NULL,
  mime        text NOT NULL,
  size        bigint NOT NULL CHECK (size > 0),
  width       int,
  height      int,
  event_id    uuid,
  chat_id     uuid,
  storage_key text NOT NULL,
  created_at  timestamptz NOT NULL,
  expires_at  timestamptz NOT NULL,
  claimed_at  timestamptz,                       -- a request is working on it (§19, Il passo 3): another meanwhile gets 409
  output_keys text[] NOT NULL DEFAULT '{}',      -- the names of the files made, chosen BEFORE calling imaged: cleaning knows what to remove
  used        boolean NOT NULL DEFAULT false
);
CREATE INDEX ON uploads (user_id) WHERE NOT used;                        -- how many waiting
CREATE INDEX ON uploads (expires_at) WHERE NOT used;                     -- cleaning

CREATE TABLE reports (
  id         uuid PRIMARY KEY,
  by_user    uuid,                                                       -- NULL when who reported deletes the account
  snapshot   jsonb NOT NULL,                                             -- how what was reported was at that moment
  kind       text NOT NULL,
  target_id  text NOT NULL,
  event_id   uuid,
  reasons    text[] NOT NULL,
  details    text,
  at         timestamptz NOT NULL,
  status     text NOT NULL DEFAULT 'open',
  handled_by uuid
);
CREATE INDEX ON reports (status, at);
CREATE INDEX ON reports (by_user) WHERE by_user IS NOT NULL;

CREATE TABLE idempotency_keys (
  user_id  uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  scope    text NOT NULL,                        -- 'event', 'photo': the same key on two routes is another thing
  key      text NOT NULL CHECK (char_length(key) BETWEEN 1 AND 64),
  made_id  uuid NOT NULL,                        -- what was made: the answer is made again as it is NOW for who asks
  at       timestamptz NOT NULL,
  PRIMARY KEY (user_id, scope, key)
);
CREATE INDEX ON idempotency_keys (at);
