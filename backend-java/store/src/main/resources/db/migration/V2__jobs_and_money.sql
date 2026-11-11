-- Jobs (JAVA-BACKEND.md §6, §8) and the guards of money that the database keeps by itself.

-- db-scheduler 16.12.0, postgresql_tables.sql of its repository, as it is (§6): a job written
-- in the same transaction as the change it follows starts only if the change is saved
create table scheduled_tasks (
  task_name text not null,
  task_instance text not null,
  task_data bytea,
  execution_time timestamp with time zone not null,
  picked BOOLEAN not null,
  picked_by text,
  last_success timestamp with time zone,
  last_failure timestamp with time zone,
  consecutive_failures INT,
  last_heartbeat timestamp with time zone,
  version BIGINT not null,
  priority SMALLINT,
  PRIMARY KEY (task_name, task_instance)
);
CREATE INDEX execution_time_idx ON scheduled_tasks (execution_time);
CREATE INDEX last_heartbeat_idx ON scheduled_tasks (last_heartbeat);
CREATE INDEX priority_execution_time_idx on scheduled_tasks (priority desc, execution_time asc);

-- What the minute jobs did to an event, so that a job run twice (§6) or late does it once
ALTER TABLE events ADD COLUMN chat_closed_at timestamptz;              -- chat.removed sent at its end (chat.close)
ALTER TABLE events ADD COLUMN chat_purged_at timestamptz;              -- its chat's messages gone, 30 days after (retention.sweep)
CREATE INDEX events_chat_to_close ON events (ends_at) WHERE chat_closed_at IS NULL AND cancelled_at IS NULL;
CREATE INDEX events_chat_to_purge ON events ((coalesce(cancelled_at, ends_at))) WHERE chat_purged_at IS NULL;
CREATE INDEX events_ended ON events ((coalesce(cancelled_at, ends_at)));

-- A purchase is credited once and taken back once: two notices of the same refund at the same
-- moment cannot both pass (Wallets.reverse reads under lock too)
DROP INDEX wallet_entries_store_key_idx;
CREATE UNIQUE INDEX wallet_entries_store_once ON wallet_entries (store_key, kind) WHERE store_key IS NOT NULL;
