import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

if (Deno.args.includes("--cors-preflight")) {
  // unused; kept for clarity
}

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

function serverClient() {
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

const PRESENCE_TTL_MS = 90_000;

function validBrowserId(value) {
  return typeof value === "string" && /^[a-z\d_-]{16,80}$/i.test(value);
}
function validPresenceSessionId(value) {
  return typeof value === "string" && /^[a-z\d_-]{16,80}$/i.test(value);
}
function safeMemberName(name) {
  return String(name || "Writer").trim().slice(0, 28) || "Writer";
}
function safeMemberColor(color) {
  return /^#[\da-f]{6}$/i.test(String(color)) ? String(color) : "#71877a";
}
function validRoomId(id) {
  return typeof id === "string" && /^[a-z\d_-]{1,100}$/i.test(id);
}
function newCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

async function buildSummary(supabase, houseId) {
  const { data: house } = await supabase.from("copad_houses").select("id, code").eq("id", houseId).maybeSingle();
  if (!house) return null;
  const { data: members } = await supabase.from("copad_house_members").select("name, color").eq("house_id", houseId);
  const { data: rooms } = await supabase.from("copad_house_rooms").select("room_id, title, owner_id, owner_name, owner_color, created_at, updated_at").eq("house_id", houseId).order("created_at", { ascending: true });
  const { data: deleted } = await supabase.from("copad_house_deleted_rooms").select("room_id, deleted_at").eq("house_id", houseId);
  const { data: presenceRows } = await supabase.from("copad_presence").select("browser_id, room_id, last_seen_at").eq("room_id", rooms?.map((r) => r.room_id) || []);
  // presence query above won't work with array; fetch all recent and filter
  const cutoff = new Date(Date.now() - PRESENCE_TTL_MS).toISOString();
  const { data: recentPresence } = await supabase.from("copad_presence").select("browser_id, room_id").gte("last_seen_at", cutoff);
  const memberById = new Map((members || []).map((m) => [m.browser_id, m]));
  // We need browser_id from members to map presence; fetch full members
  const { data: fullMembers } = await supabase.from("copad_house_members").select("browser_id, name, color").eq("house_id", houseId);
  const memberMap = new Map((fullMembers || []).map((m) => [m.browser_id, m]));
  const presenceByRoom = new Map();
  for (const p of recentPresence || []) {
    if (!memberMap.has(p.browser_id)) continue;
    if (!presenceByRoom.has(p.room_id)) presenceByRoom.set(p.room_id, []);
    const m = memberMap.get(p.browser_id);
    presenceByRoom.get(p.room_id).push({ id: p.browser_id, name: m.name, color: m.color });
  }
  return {
    code: house.code,
    members: (members || []).map(({ name, color }) => ({ name, color })),
    rooms: (rooms || []).map((r) => ({
      id: r.room_id,
      title: r.title,
      ownerId: r.owner_id,
      ownerName: r.owner_name,
      ownerColor: r.owner_color,
      createdAt: new Date(r.created_at).getTime(),
      updatedAt: new Date(r.updated_at).getTime(),
      presence: (presenceByRoom.get(r.room_id) || []).sort((a, b) => a.name.localeCompare(b.name)),
    })),
    deletedRoomIds: (deleted || []).map((d) => d.room_id),
  };
}

async function ensureAccount(supabase, browserId, name, color) {
  // Find house by member
  const { data: existingMember } = await supabase.from("copad_house_members").select("house_id").eq("browser_id", browserId).maybeSingle();
  let houseId = existingMember?.house_id;
  if (!houseId) {
    // create new house
    houseId = crypto.randomUUID();
    let code = newCode();
    let attempts = 0;
    while (attempts < 10) {
      const { data: conflict } = await supabase.from("copad_houses").select("id").eq("code", code).maybeSingle();
      if (!conflict) break;
      code = newCode();
      attempts += 1;
    }
    const { error: houseErr } = await supabase.from("copad_houses").insert({ id: houseId, code });
    if (houseErr) throw new Error("Could not create house: " + houseErr.message);
    const { error: memberErr } = await supabase.from("copad_house_members").insert({
      house_id: houseId, browser_id: browserId, name: safeMemberName(name), color: safeMemberColor(color),
    });
    if (memberErr) throw new Error("Could not add member: " + memberErr.message);
    return houseId;
  }
  // update member profile
  await supabase.from("copad_house_members").update({ name: safeMemberName(name), color: safeMemberColor(color) }).eq("house_id", houseId).eq("browser_id", browserId);
  // update owner info on rooms they own
  await supabase.from("copad_house_rooms").update({ owner_name: safeMemberName(name), owner_color: safeMemberColor(color) }).eq("house_id", houseId).eq("owner_id", browserId);
  return houseId;
}

async function mergeHouses(supabase, targetId, sourceId, browserId, name, color) {
  if (targetId === sourceId) return targetId;
  // copy members
  const { data: sourceMembers } = await supabase.from("copad_house_members").select("browser_id, name, color").eq("house_id", sourceId);
  for (const m of sourceMembers || []) {
    const { data: existing } = await supabase.from("copad_house_members").select("browser_id").eq("house_id", targetId).eq("browser_id", m.browser_id).maybeSingle();
    if (existing) {
      await supabase.from("copad_house_members").update({ name: m.name, color: m.color }).eq("house_id", targetId).eq("browser_id", m.browser_id);
    } else {
      await supabase.from("copad_house_members").insert({ house_id: targetId, browser_id: m.browser_id, name: m.name, color: m.color });
    }
  }
  // copy rooms (skip deleted)
  const { data: deletedInTarget } = await supabase.from("copad_house_deleted_rooms").select("room_id").eq("house_id", targetId);
  const deletedSet = new Set((deletedInTarget || []).map((d) => d.room_id));
  const { data: sourceRooms } = await supabase.from("copad_house_rooms").select("room_id, title, owner_id, owner_name, owner_color, created_at, updated_at").eq("house_id", sourceId);
  for (const r of sourceRooms || []) {
    if (deletedSet.has(r.room_id)) continue;
    const { data: existing } = await supabase.from("copad_house_rooms").select("room_id, updated_at").eq("house_id", targetId).eq("room_id", r.room_id).maybeSingle();
    if (existing) {
      if (new Date(r.updated_at).getTime() > new Date(existing.updated_at).getTime()) {
        await supabase.from("copad_house_rooms").update({ title: r.title, updated_at: r.updated_at }).eq("house_id", targetId).eq("room_id", r.room_id);
      }
    } else {
      await supabase.from("copad_house_rooms").insert({
        house_id: targetId, room_id: r.room_id, title: r.title, owner_id: r.owner_id, owner_name: r.owner_name, owner_color: r.owner_color, created_at: r.created_at, updated_at: r.updated_at,
      });
    }
  }
  // copy deleted rooms
  const { data: sourceDeleted } = await supabase.from("copad_house_deleted_rooms").select("room_id, deleted_at").eq("house_id", sourceId);
  for (const d of sourceDeleted || []) {
    const { data: existing } = await supabase.from("copad_house_deleted_rooms").select("room_id").eq("house_id", targetId).eq("room_id", d.room_id).maybeSingle();
    if (!existing) {
      await supabase.from("copad_house_deleted_rooms").insert({ house_id: targetId, room_id: d.room_id, deleted_at: d.deleted_at });
      await supabase.from("copad_house_rooms").delete().eq("house_id", targetId).eq("room_id", d.room_id);
    }
  }
  // delete source house (cascade deletes remaining source members/rooms)
  await supabase.from("copad_houses").delete().eq("id", sourceId);
  // ensure caller is member of target
  const { data: caller } = await supabase.from("copad_house_members").select("browser_id").eq("house_id", targetId).eq("browser_id", browserId).maybeSingle();
  if (!caller) {
    await supabase.from("copad_house_members").insert({ house_id: targetId, browser_id: browserId, name: safeMemberName(name), color: safeMemberColor(color) });
  } else {
    await supabase.from("copad_house_members").update({ name: safeMemberName(name), color: safeMemberColor(color) }).eq("house_id", targetId).eq("browser_id", browserId);
  }
  return targetId;
}

async function handleRequest(req, url) {
  const supabase = serverClient();
  const action = url.pathname.replace(/^\/copad-unicode\/?/, "") || url.pathname.split("/").pop();

  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

  if (action === "account" && req.method === "POST") {
    const body = await req.json();
    if (!validBrowserId(body.browserId)) return json(400, { error: "Invalid browser identity." });
    const houseId = await ensureAccount(supabase, body.browserId, body.name, body.color);
    const summary = await buildSummary(supabase, houseId);
    return json(200, summary);
  }

  if (action === "rooms" && req.method === "GET") {
    const browserId = url.searchParams.get("browserId");
    if (!validBrowserId(browserId)) return json(400, { error: "Invalid browser identity." });
    const { data: member } = await supabase.from("copad_house_members").select("house_id").eq("browser_id", browserId).maybeSingle();
    if (!member) return json(404, { error: "UniCode account is not connected." });
    const summary = await buildSummary(supabase, member.house_id);
    return json(200, summary);
  }

  if (action === "room" && req.method === "POST") {
    const body = await req.json();
    if (!validBrowserId(body.browserId) || !validRoomId(body.id)) return json(400, { error: "Invalid room information." });
    const { data: member } = await supabase.from("copad_house_members").select("house_id").eq("browser_id", body.browserId).maybeSingle();
    if (!member) return json(404, { error: "UniCode account is not connected." });
    const houseId = member.house_id;
    const { data: deleted } = await supabase.from("copad_house_deleted_rooms").select("room_id").eq("house_id", houseId).eq("room_id", body.id).maybeSingle();
    if (deleted) {
      return json(410, { error: "This room was deleted for everyone.", deletedRoomId: body.id });
    }
    const { data: prev } = await supabase.from("copad_house_rooms").select("owner_id, created_at").eq("house_id", houseId).eq("room_id", body.id).maybeSingle();
    const now = new Date().toISOString();
    const roomRow = {
      house_id: houseId,
      room_id: body.id,
      title: String(body.title || "Untitled room").trim().slice(0, 100) || "Untitled room",
      owner_id: prev?.owner_id || body.browserId,
      owner_name: prev?.owner_id === body.browserId ? safeMemberName(body.name) : undefined,
      owner_color: prev?.owner_id === body.browserId ? safeMemberColor(body.color) : undefined,
      created_at: prev?.created_at || now,
      updated_at: now,
    };
    // only set owner_name/color if owner
    if (prev?.owner_id !== body.browserId) {
      delete roomRow.owner_name;
      delete roomRow.owner_color;
      // fetch existing owner info
      const { data: existing } = await supabase.from("copad_house_rooms").select("owner_name, owner_color").eq("house_id", houseId).eq("room_id", body.id).maybeSingle();
      if (existing) { roomRow.owner_name = existing.owner_name; roomRow.owner_color = existing.owner_color; }
    }
    await supabase.from("copad_house_rooms").upsert(roomRow, { onConflict: "house_id,room_id" });
    const { data: room } = await supabase.from("copad_house_rooms").select("room_id, title, owner_id, owner_name, owner_color, created_at, updated_at").eq("house_id", houseId).eq("room_id", body.id).maybeSingle();
    return json(200, { room: { id: room.room_id, title: room.title, ownerId: room.owner_id, ownerName: room.owner_name, ownerColor: room.owner_color, createdAt: new Date(room.created_at).getTime(), updatedAt: new Date(room.updated_at).getTime() } });
  }

  if (action === "room" && req.method === "DELETE") {
    const body = await req.json();
    if (!validBrowserId(body.browserId) || !validRoomId(body.id)) return json(400, { error: "Invalid room information." });
    const { data: member } = await supabase.from("copad_house_members").select("house_id").eq("browser_id", body.browserId).maybeSingle();
    if (!member) return json(404, { error: "UniCode house not found." });
    const houseId = member.house_id;
    const now = new Date().toISOString();
    await supabase.from("copad_house_deleted_rooms").upsert({ house_id: houseId, room_id: body.id, deleted_at: now }, { onConflict: "house_id,room_id" });
    await supabase.from("copad_house_rooms").delete().eq("house_id", houseId).eq("room_id", body.id);
    await supabase.from("copad_presence").delete().eq("room_id", body.id);
    await supabase.from("copad_documents").delete().eq("room_id", body.id);
    const summary = await buildSummary(supabase, houseId);
    return json(200, summary);
  }

  if (action === "link" && req.method === "POST") {
    const body = await req.json();
    if (!validBrowserId(body.browserId) || !/^\d{6}$/.test(String(body.code || ""))) return json(400, { error: "Enter a valid six-digit UniCode." });
    const { data: target } = await supabase.from("copad_houses").select("id").eq("code", String(body.code)).maybeSingle();
    if (!target) return json(404, { error: "That UniCode was not found." });
    const sourceId = await ensureAccount(supabase, body.browserId, body.name, body.color);
    await mergeHouses(supabase, target.id, sourceId, body.browserId, body.name, body.color);
    const summary = await buildSummary(supabase, target.id);
    return json(200, summary);
  }

  if (action === "presence" && req.method === "POST") {
    const body = await req.json();
    if (!validBrowserId(body.browserId) || !validPresenceSessionId(body.sessionId)) return json(400, { error: "Invalid room presence information." });
    if (body.leave === true) {
      await supabase.from("copad_presence").delete().eq("session_id", body.sessionId);
      return json(200, { ok: true });
    }
    if (!validRoomId(body.roomId)) return json(400, { error: "Invalid room presence information." });
    const { data: member } = await supabase.from("copad_house_members").select("house_id").eq("browser_id", body.browserId).maybeSingle();
    if (!member) return json(404, { error: "UniCode house member not found." });
    const { data: room } = await supabase.from("copad_house_rooms").select("room_id").eq("house_id", member.house_id).eq("room_id", body.roomId).maybeSingle();
    if (!room) return json(404, { error: "This room is not available in your UniCode house yet." });
    await supabase.from("copad_presence").upsert({
      session_id: body.sessionId, browser_id: body.browserId, room_id: body.roomId, last_seen_at: new Date().toISOString(),
    }, { onConflict: "session_id" });
    return json(200, { ok: true });
  }

  return json(404, { error: "UniCode endpoint not found." });
}

Deno.serve(async (req) => {
  let url;
  try { url = new URL(req.url); }
  catch { return new Response("Bad request", { status: 400, headers: corsHeaders }); }
  try {
    return await handleRequest(req, url);
  } catch (error) {
    console.error("copad-unicode error:", error.message);
    return json(500, { error: "UniCode service is temporarily unavailable." });
  }
});
/* touched Tue Oct 20 18:36:02 UTC 2026 */
