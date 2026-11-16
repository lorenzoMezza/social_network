-- Push (JAVA-BACKEND.md §18, Push): how far each member was already told about, so that a
-- push.chat run twice or late never tells the same messages again
ALTER TABLE chat_members ADD COLUMN pushed_counter bigint NOT NULL DEFAULT 0;
