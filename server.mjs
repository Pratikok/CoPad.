import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, relative, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { isIP } from 'node:net';
import { randomInt, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const require = createRequire(import.meta.url);
const Y = require('yjs');
const { docs, getYDoc, setupWSConnection } = require('y-websocket/bin/utils');
const root = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(root, 'copad-data');
const unicodeFile = resolve(dataDir, 'unicode-registry.json');
const portArg = process.argv.indexOf('--port');
const port = portArg >= 0 ? Number(process.argv[portArg + 1]) : 8000;
const mimeTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.ico', 'image/x-icon'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.wav', 'audio/wav'],
  ['.mp3', 'audio/mpeg'],
]);

function loadUnicodeRegistry() {
  if (!existsSync(unicodeFile)) return { accounts: {}, groups: {}, codes: {}, deletedRooms: {} };
  try {
    const value = JSON.parse(readFileSync(unicodeFile, 'utf8'));
    if (value && value.accounts && value.groups && value.codes) {
      value.deletedRooms ||= {};
      for (const group of Object.values(value.groups)) group.deletedRooms ||= {};
      return value;
    }
  } catch (error) { console.error(`Could not read UniCode registry: ${error.message}`); }
  return { accounts: {}, groups: {}, codes: {}, deletedRooms: {} };
}
const unicodeRegistry = loadUnicodeRegistry();
const deletedDocumentNames = new Set(Object.keys(unicodeRegistry.deletedRooms).map((id) => `margin-${id}`));
const unicodePresence = new Map();
// Browsers throttle timers in background tabs. Keep a writer present across a
// throttled heartbeat, while the explicit pagehide beacon still removes them
// immediately when the tab closes or navigates away.
const unicodePresenceTtlMs = 90_000;
const roomPresenceProtocolVersion = 1;
const serverStartedAt = Date.now();
let shuttingDown = false;
function saveUnicodeRegistry() {
  mkdirSync(dataDir, { recursive: true });
  const temporary = `${unicodeFile}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(unicodeRegistry));
  renameSync(temporary, unicodeFile);
}
function newUnicodeCode() {
  let code;
  do { code = String(randomInt(100000, 1000000)); } while (unicodeRegistry.codes[code]);
  return code;
}
function safeMemberName(name) { return String(name || 'Writer').trim().slice(0, 28) || 'Writer'; }
function safeMemberColor(color) { return /^#[\da-f]{6}$/i.test(String(color)) ? String(color) : '#71877a'; }
function validBrowserId(value) { return typeof value === 'string' && /^[a-z\d_-]{16,80}$/i.test(value); }
function validPresenceSessionId(value) { return typeof value === 'string' && /^[a-z\d_-]{16,80}$/i.test(value); }
function pruneUnicodePresence(now = Date.now()) {
  for (const [sessionId, presence] of unicodePresence) {
    if (now - presence.lastSeenAt > unicodePresenceTtlMs) unicodePresence.delete(sessionId);
  }
}
function findGroup(groupId) { return groupId ? unicodeRegistry.groups[groupId] || null : null; }
function createUnicodeGroup(browserId, name, color) {
  const id = randomUUID();
  const code = newUnicodeCode();
  const group = { id, code, codes: [code], members: {}, rooms: {}, deletedRooms: {} };
  group.members[browserId] = { id: browserId, name: safeMemberName(name), color: safeMemberColor(color) };
  unicodeRegistry.groups[id] = group;
  unicodeRegistry.codes[code] = id;
  unicodeRegistry.accounts[browserId] = id;
  return group;
}
function ensureUnicodeAccount(browserId, name, color) {
  let group = findGroup(unicodeRegistry.accounts[browserId]);
  if (!group) group = createUnicodeGroup(browserId, name, color);
  const member = { id: browserId, name: safeMemberName(name), color: safeMemberColor(color) };
  group.members[browserId] = member;
  for (const room of Object.values(group.rooms)) {
    if (room.ownerId === browserId) { room.ownerName = member.name; room.ownerColor = member.color; }
  }
  unicodeRegistry.accounts[browserId] = group.id;
  saveUnicodeRegistry();
  return group;
}
function mergeUnicodeGroups(target, source) {
  if (!source || source.id === target.id) return;
  target.deletedRooms ||= {};
  Object.assign(target.deletedRooms, source.deletedRooms || {});
  for (const [memberId, member] of Object.entries(source.members)) target.members[memberId] = member;
  for (const [roomId, room] of Object.entries(source.rooms)) {
    if (unicodeRegistry.deletedRooms[roomId] || target.deletedRooms[roomId]) continue;
    const current = target.rooms[roomId];
    if (!current) target.rooms[roomId] = room;
    else if (current.updatedAt < room.updatedAt) {
      current.title = room.title;
      current.updatedAt = room.updatedAt;
      current.createdAt = Math.min(current.createdAt || room.createdAt, room.createdAt || current.createdAt);
    }
  }
  for (const code of source.codes || [source.code]) {
    if (!target.codes.includes(code)) target.codes.push(code);
    unicodeRegistry.codes[code] = target.id;
  }
  for (const roomId of Object.keys(target.deletedRooms)) delete target.rooms[roomId];
  for (const [memberId, groupId] of Object.entries(unicodeRegistry.accounts)) {
    if (groupId === source.id) unicodeRegistry.accounts[memberId] = target.id;
  }
  delete unicodeRegistry.groups[source.id];
}
function unicodeSummary(group) {
  pruneUnicodePresence();
  const rooms = Object.values(group.rooms).map(({ ownerId, ...room }) => {
    const document = docs.get(`margin-${room.id}`);
    const states = document?.awareness?.getStates?.() || new Map();
    const activePeople = new Map();
    for (const [clientId, state] of states) {
      const person = state?.user;
      if (!person?.name) continue;
      // Housemates may be on an already-open tab running an older app bundle,
      // which has no browserId in awareness yet. Room awareness is the source
      // of truth for who is in this specific room, so retain those peers too.
      const id = validBrowserId(person.browserId) ? person.browserId : `client-${clientId}`;
      activePeople.set(id, {
        id,
        name: safeMemberName(person.name),
        color: safeMemberColor(person.color),
      });
    }
    for (const presence of unicodePresence.values()) {
      if (presence.roomId !== room.id || unicodeRegistry.accounts[presence.browserId] !== group.id) continue;
      const member = group.members[presence.browserId];
      if (member) activePeople.set(presence.browserId, { id: presence.browserId, name: member.name, color: member.color });
    }
    return {
      ...room,
      presence: [...activePeople.values()].sort((a, b) => a.name.localeCompare(b.name)),
    };
  }).sort((a, b) => a.createdAt - b.createdAt);
  return {
    code: group.code,
    members: Object.values(group.members).map(({ name, color }) => ({ name, color })),
    rooms,
    deletedRoomIds: Object.keys(group.deletedRooms || {}),
  };
}
const unicodeRequestAttempts = new Map();
function requestAddress(request) {
  const remote = request.socket.remoteAddress || 'unknown';
  const localProxy = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  if (localProxy) {
    const forwarded = String(request.headers['x-forwarded-for'] || '').split(',').map((value) => value.trim()).filter(Boolean);
    const proxiedAddress = forwarded.at(-1);
    if (proxiedAddress && isIP(proxiedAddress)) return proxiedAddress;
  }
  return remote;
}
function withinRateLimit(request, bucket, maximum) {
  const ip = requestAddress(request);
  const now = Date.now();
  const recent = (unicodeRequestAttempts.get(`${bucket}:${ip}`) || []).filter((stamp) => now - stamp < 60_000);
  if (recent.length >= maximum) return false;
  recent.push(now);
  unicodeRequestAttempts.set(`${bucket}:${ip}`, recent);
  if (unicodeRequestAttempts.size > 2048) {
    for (const [key, stamps] of unicodeRequestAttempts) {
      if (!stamps.some((stamp) => now - stamp < 60_000)) unicodeRequestAttempts.delete(key);
    }
  }
  return true;
}
async function readJsonBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 64 * 1024) throw Object.assign(new Error('Request is too large.'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw Object.assign(new Error('Invalid JSON.'), { status: 400 }); }
}
function jsonResponse(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(value));
}
function deleteRoomDocument(roomId) {
  const name = `margin-${roomId}`;
  deletedDocumentNames.add(name);
  clearTimeout(saveTimers.get(name));
  saveTimers.delete(name);
  const doc = docs.get(name);
  if (doc) {
    for (const connection of [...doc.conns.keys()]) {
      try { connection.close(4001, 'This room was deleted for everyone.'); }
      catch (error) { console.warn(`Could not close a deleted room connection: ${error.message}`); }
    }
    docs.delete(name);
    initializedDocs.delete(name);
  }
  const destination = resolve(dataDir, `${Buffer.from(name).toString('hex')}.yjs`);
  if (existsSync(destination)) unlinkSync(destination);
}
async function handleUnicodeApi(request, response, url) {
  if (request.method === 'OPTIONS') { response.writeHead(204, { Allow: 'GET, POST, OPTIONS' }).end(); return; }
  if (request.method === 'POST' && url.pathname === '/api/unicode/account') {
    if (!withinRateLimit(request, 'account', 40)) return jsonResponse(response, 429, { error: 'Too many account updates. Wait a minute and try again.' });
    const body = await readJsonBody(request);
    if (!validBrowserId(body.browserId)) return jsonResponse(response, 400, { error: 'Invalid browser identity.' });
    const group = ensureUnicodeAccount(body.browserId, body.name, body.color);
    return jsonResponse(response, 200, unicodeSummary(group));
  }
  if (request.method === 'POST' && url.pathname === '/api/unicode/presence') {
    if (!withinRateLimit(request, 'presence', 180)) return jsonResponse(response, 429, { error: 'Too many presence updates. Wait a moment and try again.' });
    const body = await readJsonBody(request);
    if (!validBrowserId(body.browserId) || !validPresenceSessionId(body.sessionId)) return jsonResponse(response, 400, { error: 'Invalid room presence information.' });
    pruneUnicodePresence();
    const previous = unicodePresence.get(body.sessionId);
    if (previous && previous.browserId !== body.browserId) return jsonResponse(response, 409, { error: 'This presence session is already in use.' });
    if (body.leave === true) {
      if (previous?.browserId === body.browserId) unicodePresence.delete(body.sessionId);
      return jsonResponse(response, 200, { ok: true });
    }
    if (typeof body.roomId !== 'string' || !/^[a-z\d_-]{1,100}$/i.test(body.roomId)) return jsonResponse(response, 400, { error: 'Invalid room presence information.' });
    const group = findGroup(unicodeRegistry.accounts[body.browserId]);
    if (!group?.members[body.browserId]) return jsonResponse(response, 404, { error: 'UniCode house member not found.' });
    if (!group.rooms[body.roomId] || group.deletedRooms?.[body.roomId] || unicodeRegistry.deletedRooms[body.roomId]) {
      return jsonResponse(response, 404, { error: 'This room is not available in your UniCode house yet.' });
    }
    unicodePresence.set(body.sessionId, { browserId: body.browserId, roomId: body.roomId, lastSeenAt: Date.now() });
    return jsonResponse(response, 200, { ok: true });
  }
  if (request.method === 'GET' && url.pathname === '/api/unicode/rooms') {
    const browserId = url.searchParams.get('browserId');
    if (!validBrowserId(browserId)) return jsonResponse(response, 400, { error: 'Invalid browser identity.' });
    const group = findGroup(unicodeRegistry.accounts[browserId]);
    if (!group) return jsonResponse(response, 404, { error: 'UniCode account is not connected.' });
    return jsonResponse(response, 200, unicodeSummary(group));
  }
  if (request.method === 'POST' && url.pathname === '/api/unicode/link') {
    if (!withinRateLimit(request, 'join', 12)) return jsonResponse(response, 429, { error: 'Too many code attempts. Wait a minute and try again.' });
    const body = await readJsonBody(request);
    if (!validBrowserId(body.browserId) || !/^\d{6}$/.test(String(body.code || ''))) return jsonResponse(response, 400, { error: 'Enter a valid six-digit UniCode.' });
    const target = findGroup(unicodeRegistry.codes[String(body.code)]);
    if (!target) return jsonResponse(response, 404, { error: 'That UniCode was not found.' });
    const source = ensureUnicodeAccount(body.browserId, body.name, body.color);
    mergeUnicodeGroups(target, source);
    target.members[body.browserId] = { id: body.browserId, name: safeMemberName(body.name), color: safeMemberColor(body.color) };
    unicodeRegistry.accounts[body.browserId] = target.id;
    saveUnicodeRegistry();
    return jsonResponse(response, 200, unicodeSummary(target));
  }
  if (request.method === 'DELETE' && url.pathname === '/api/unicode/room') {
    const body = await readJsonBody(request);
    if (!validBrowserId(body.browserId) || typeof body.id !== 'string' || !/^[a-z\d_-]{1,100}$/i.test(body.id)) return jsonResponse(response, 400, { error: 'Invalid room information.' });
    const group = findGroup(unicodeRegistry.accounts[body.browserId]);
    if (!group) return jsonResponse(response, 404, { error: 'UniCode house not found.' });
    group.deletedRooms ||= {};
    const deletedAt = unicodeRegistry.deletedRooms[body.id] || Date.now();
    deletedDocumentNames.add(`margin-${body.id}`);
    unicodeRegistry.deletedRooms[body.id] = deletedAt;
    for (const otherGroup of Object.values(unicodeRegistry.groups)) {
      otherGroup.deletedRooms ||= {};
      if (otherGroup.id === group.id || otherGroup.rooms[body.id]) {
        otherGroup.deletedRooms[body.id] = deletedAt;
        delete otherGroup.rooms[body.id];
      }
    }
    group.deletedRooms[body.id] = deletedAt;
    delete group.rooms[body.id];
    for (const [sessionId, presence] of unicodePresence) {
      if (presence.roomId === body.id) unicodePresence.delete(sessionId);
    }
    saveUnicodeRegistry();
    deleteRoomDocument(body.id);
    return jsonResponse(response, 200, unicodeSummary(group));
  }
  if (request.method === 'POST' && url.pathname === '/api/unicode/room') {
    const body = await readJsonBody(request);
    if (!validBrowserId(body.browserId) || typeof body.id !== 'string' || !/^[a-z\d_-]{1,100}$/i.test(body.id)) return jsonResponse(response, 400, { error: 'Invalid room information.' });
    const group = findGroup(unicodeRegistry.accounts[body.browserId]);
    if (!group) return jsonResponse(response, 404, { error: 'UniCode account is not connected.' });
    if (unicodeRegistry.deletedRooms[body.id] || group.deletedRooms?.[body.id]) {
      group.deletedRooms ||= {};
      group.deletedRooms[body.id] ||= unicodeRegistry.deletedRooms[body.id] || Date.now();
      delete group.rooms[body.id];
      unicodeRegistry.deletedRooms[body.id] ||= group.deletedRooms[body.id];
      saveUnicodeRegistry();
      return jsonResponse(response, 410, { error: 'This room was deleted for everyone.', deletedRoomId: body.id });
    }
    const previous = group.rooms[body.id];
    const now = Date.now();
    group.rooms[body.id] = {
      id: body.id,
      title: String(body.title || 'Untitled room').trim().slice(0, 100) || 'Untitled room',
      ownerId: previous?.ownerId || body.browserId,
      ownerName: previous?.ownerName || safeMemberName(body.name),
      ownerColor: previous?.ownerColor || safeMemberColor(body.color),
      createdAt: previous?.createdAt || now,
      updatedAt: now,
    };
    saveUnicodeRegistry();
    return jsonResponse(response, 200, { room: group.rooms[body.id] });
  }
  jsonResponse(response, 404, { error: 'UniCode endpoint not found.' });
}

const server = createServer(async (request, response) => {
  let url;
  try { url = new URL(request.url, 'http://localhost'); }
  catch { response.writeHead(400).end('Bad request'); return; }
  if (url.pathname.startsWith('/api/unicode')) {
    try { await handleUnicodeApi(request, response, url); }
    catch (error) { console.error(`UniCode API error: ${error.message}`); jsonResponse(response, error.status || 500, { error: error.status ? error.message : 'UniCode service is temporarily unavailable.' }); }
    return;
  }
  if (request.url === '/__copad_health') {
    jsonResponse(response, 200, {
      service: 'CoPad',
      status: shuttingDown ? 'restarting' : 'ready',
      roomPresenceProtocol: roomPresenceProtocolVersion,
      startedAt: serverStartedAt,
    });
    return;
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }
  let pathname;
  try { pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname); }
  catch { response.writeHead(400).end('Bad request'); return; }
  if (pathname === '/') pathname = '/index.html';
  const filePath = resolve(root, `.${pathname}`);
  // Room documents and the UniCode registry live under dataDir and must never
  // be reachable through the static file server.
  const privateDataPath = relative(root, filePath).split(sep).some((part) => part.toLowerCase() === 'copad-data');
  if (!filePath.startsWith(`${root}${sep}`) || privateDataPath) {
    response.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const file = statSync(filePath);
    if (!file.isFile()) throw new Error('Not a file');
    response.writeHead(200, {
      'Content-Type': mimeTypes.get(extname(filePath).toLowerCase()) || 'application/octet-stream',
      'Content-Length': file.size,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-cache',
    });
    if (request.method === 'HEAD') response.end();
    else createReadStream(filePath).pipe(response);
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
  }
});

const websocketServer = new WebSocket.Server({ noServer: true, maxPayload: 8 * 1024 * 1024 });
websocketServer.on('connection', setupWSConnection);
const initializedDocs = new Set();
const saveTimers = new Map();
function persistDocument(name, doc) {
  if (deletedDocumentNames.has(name)) return;
  const fileName = `${Buffer.from(name).toString('hex')}.yjs`;
  const destination = resolve(dataDir, fileName);
  const temporary = `${destination}.${process.pid}.tmp`;
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(temporary, Buffer.from(Y.encodeStateAsUpdate(doc)));
  renameSync(temporary, destination);
}
function schedulePersist(name, doc) {
  clearTimeout(saveTimers.get(name));
  const timer = setTimeout(() => {
    try { persistDocument(name, doc); }
    catch (error) { console.error(`Could not save room ${name}: ${error.message}`); }
    saveTimers.delete(name);
  }, 350);
  timer.unref();
  saveTimers.set(name, timer);
}
function prepareDocument(name) {
  if (deletedDocumentNames.has(name)) throw new Error('This room was deleted for everyone.');
  const doc = getYDoc(name);
  if (initializedDocs.has(name)) return doc;
  const destination = resolve(dataDir, `${Buffer.from(name).toString('hex')}.yjs`);
  if (existsSync(destination)) Y.applyUpdate(doc, new Uint8Array(readFileSync(destination)));
  initializedDocs.add(name);
  doc.on('update', () => schedulePersist(name, doc));
  return doc;
}
server.on('upgrade', (request, socket, head) => {
  let pathname;
  try { pathname = new URL(request.url, 'http://localhost').pathname; }
  catch { socket.destroy(); return; }
  if (!/^\/[a-z0-9_-]{1,100}$/i.test(pathname)) { socket.destroy(); return; }
  const documentName = decodeURIComponent(pathname.slice(1));
  if (deletedDocumentNames.has(documentName)) {
    socket.end('HTTP/1.1 410 Gone\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    return;
  }
  prepareDocument(documentName);
  websocketServer.handleUpgrade(request, socket, head, (connection) => {
    websocketServer.emit('connection', connection, request);
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`CoPad HTTP and collaboration server listening on http://127.0.0.1:${port}`);
});
server.on('error', (error) => {
  console.error(`CoPad server error: ${error.message}`);
  process.exitCode = 1;
});
function flushAllDocuments() {
  for (const [name, doc] of docs) {
    clearTimeout(saveTimers.get(name));
    saveTimers.delete(name);
    try { persistDocument(name, doc); }
    catch (error) { console.error(`Could not save room ${name}: ${error.message}`); }
  }
}

let shutdownStarted = false;
function shutdown(signal) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  shuttingDown = true;
  console.log(`CoPad is saving rooms before ${signal} shutdown.`);

  // Stop accepting new HTTP and WebSocket connections, then give open Yjs
  // connections a brief close handshake before the final durable snapshot.
  server.close();
  for (const doc of docs.values()) {
    for (const connection of [...doc.conns.keys()]) {
      try { connection.close(1012, 'CoPad is restarting'); }
      catch (error) { console.warn(`Could not close a room connection cleanly: ${error.message}`); }
    }
  }

  const forceExit = setTimeout(() => {
    flushAllDocuments();
    for (const doc of docs.values()) {
      for (const connection of [...doc.conns.keys()]) {
        try { connection.terminate(); } catch { /* The peer may already be closed. */ }
      }
    }
    process.exit(1);
  }, 5000);
  forceExit.unref();

  setTimeout(() => {
    flushAllDocuments();
    server.close(() => {
      clearTimeout(forceExit);
      process.exit(0);
    });
  }, 250);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
