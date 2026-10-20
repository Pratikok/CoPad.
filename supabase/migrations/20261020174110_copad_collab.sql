/*
# CoPad collaboration storage

1. Purpose
   CoPad is a shared notepad. Previously room documents were stored as .yjs
   binary files on a local Node server and synced over a WebSocket. Now the
   app is hosted statically and uses Supabase Realtime broadcast for live
   syncing, with room document state persisted in Postgres so rooms survive
   across reloads and are not dependent on temporary server memory.

2. New Tables
   - `copad_documents`: one row per room. Stores the Yjs document state as
     bytes (`state`, bytea) plus a monotonic `state_vector` (bytea) so clients
     can decide whether to merge missing updates. `updated_at` tracks the last
     persisted change.
   - `copad_houses`: UniCode "house" groups. Replaces the in-memory registry.
     `id` (text, primary key) is the house UUID. `code` is the 6-digit join
     code, unique. `created_at` timestamp.
   - `copad_house_members`: members of a house. `house_id` + `browser_id` is
     the unique key. Stores `name` and `color`.
   - `copad_house_rooms`: rooms known to a house. `house_id` + `room_id`
     unique. Stores `title`, `owner_id`, `owner_name`, `owner_color`,
     `created_at`, `updated_at`.
   - `copad_house_deleted_rooms`: tombstones for deleted rooms so all members
     learn a room was removed. `house_id` + `room_id` unique. `deleted_at`.

3. Security
   - This is a no-auth app (visitors only enter a display name). Per the
     bolt-database skill, policies use `TO anon, authenticated` with
     `USING (true)` / `WITH CHECK (true)` because room data is intentionally
     shared with anyone who has the room link.
   - RLS enabled on every table.
*/

CREATE TABLE IF NOT EXISTS copad_documents (
  room_id text PRIMARY KEY,
  state bytea,
  state_vector bytea,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE copad_documents ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "copad_docs_read" ON copad_documents;
CREATE POLICY "copad_docs_read" ON copad_documents FOR SELECT
  TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "copad_docs_insert" ON copad_documents;
CREATE POLICY "copad_docs_insert" ON copad_documents FOR INSERT
  TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "copad_docs_update" ON copad_documents;
CREATE POLICY "copad_docs_update" ON copad_documents FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "copad_docs_delete" ON copad_documents;
CREATE POLICY "copad_docs_delete" ON copad_documents FOR DELETE
  TO anon, authenticated USING (true);

CREATE TABLE IF NOT EXISTS copad_houses (
  id text PRIMARY KEY,
  code text UNIQUE NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE copad_houses ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "copad_houses_read" ON copad_houses;
CREATE POLICY "copad_houses_read" ON copad_houses FOR SELECT
  TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "copad_houses_insert" ON copad_houses;
CREATE POLICY "copad_houses_insert" ON copad_houses FOR INSERT
  TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "copad_houses_update" ON copad_houses;
CREATE POLICY "copad_houses_update" ON copad_houses FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "copad_houses_delete" ON copad_houses;
CREATE POLICY "copad_houses_delete" ON copad_houses FOR DELETE
  TO anon, authenticated USING (true);

CREATE TABLE IF NOT EXISTS copad_house_members (
  house_id text NOT NULL REFERENCES copad_houses(id) ON DELETE CASCADE,
  browser_id text NOT NULL,
  name text NOT NULL DEFAULT 'Writer',
  color text NOT NULL DEFAULT '#71877a',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (house_id, browser_id)
);

ALTER TABLE copad_house_members ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "copad_members_read" ON copad_house_members;
CREATE POLICY "copad_members_read" ON copad_house_members FOR SELECT
  TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "copad_members_insert" ON copad_house_members;
CREATE POLICY "copad_members_insert" ON copad_house_members FOR INSERT
  TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "copad_members_update" ON copad_house_members;
CREATE POLICY "copad_members_update" ON copad_house_members FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "copad_members_delete" ON copad_house_members;
CREATE POLICY "copad_members_delete" ON copad_house_members FOR DELETE
  TO anon, authenticated USING (true);

CREATE TABLE IF NOT EXISTS copad_house_rooms (
  house_id text NOT NULL REFERENCES copad_houses(id) ON DELETE CASCADE,
  room_id text NOT NULL,
  title text NOT NULL DEFAULT 'Untitled room',
  owner_id text,
  owner_name text,
  owner_color text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (house_id, room_id)
);

ALTER TABLE copad_house_rooms ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "copad_rooms_read" ON copad_house_rooms;
CREATE POLICY "copad_rooms_read" ON copad_house_rooms FOR SELECT
  TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "copad_rooms_insert" ON copad_house_rooms;
CREATE POLICY "copad_rooms_insert" ON copad_house_rooms FOR INSERT
  TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "copad_rooms_update" ON copad_house_rooms;
CREATE POLICY "copad_rooms_update" ON copad_house_rooms FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "copad_rooms_delete" ON copad_house_rooms;
CREATE POLICY "copad_rooms_delete" ON copad_house_rooms FOR DELETE
  TO anon, authenticated USING (true);

CREATE TABLE IF NOT EXISTS copad_house_deleted_rooms (
  house_id text NOT NULL REFERENCES copad_houses(id) ON DELETE CASCADE,
  room_id text NOT NULL,
  deleted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (house_id, room_id)
);

ALTER TABLE copad_house_deleted_rooms ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "copad_deleted_read" ON copad_house_deleted_rooms;
CREATE POLICY "copad_deleted_read" ON copad_house_deleted_rooms FOR SELECT
  TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "copad_deleted_insert" ON copad_house_deleted_rooms;
CREATE POLICY "copad_deleted_insert" ON copad_house_deleted_rooms FOR INSERT
  TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "copad_deleted_delete" ON copad_house_deleted_rooms;
CREATE POLICY "copad_deleted_delete" ON copad_house_deleted_rooms FOR DELETE
  TO anon, authenticated USING (true);

CREATE INDEX IF NOT EXISTS copad_house_rooms_house_idx ON copad_house_rooms(house_id);
CREATE INDEX IF NOT EXISTS copad_house_members_house_idx ON copad_house_members(house_id);
CREATE INDEX IF NOT EXISTS copad_house_deleted_house_idx ON copad_house_deleted_rooms(house_id);