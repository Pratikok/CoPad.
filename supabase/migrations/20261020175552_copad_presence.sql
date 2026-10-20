/*
# CoPad presence tracking

1. Purpose
   Stores ephemeral "who is currently in which room" heartbeats so the
   UniCode room sidebar can show active writers. The app sends a heartbeat
   every few seconds; old rows are pruned on read.

2. New Tables
   - `copad_presence`: session_id (PK), browser_id, room_id, last_seen_at.

3. Security
   - No-auth app: anon + authenticated CRUD with USING(true) / WITH CHECK(true)
     since room presence is intentionally shared.
*/

CREATE TABLE IF NOT EXISTS copad_presence (
  session_id text PRIMARY KEY,
  browser_id text NOT NULL,
  room_id text NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE copad_presence ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "copad_presence_read" ON copad_presence;
CREATE POLICY "copad_presence_read" ON copad_presence FOR SELECT
  TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "copad_presence_insert" ON copad_presence;
CREATE POLICY "copad_presence_insert" ON copad_presence FOR INSERT
  TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "copad_presence_update" ON copad_presence;
CREATE POLICY "copad_presence_update" ON copad_presence FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "copad_presence_delete" ON copad_presence;
CREATE POLICY "copad_presence_delete" ON copad_presence FOR DELETE
  TO anon, authenticated USING (true);

CREATE INDEX IF NOT EXISTS copad_presence_room_idx ON copad_presence(room_id);