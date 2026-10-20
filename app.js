import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';
import { createSupabaseProvider } from './src/supabase-provider.js';

const $ = (selector) => document.querySelector(selector);
const editor = $('#editor');
const titleInput = $('#note-title');
const params = new URLSearchParams(location.search);
let room = params.get('room') || '';
let hasRoom = Boolean(room);
document.documentElement.classList.toggle('empty-lobby', !hasRoom);
if (hasRoom && /^[a-z\d_-]{1,80}$/i.test(room)) localStorage.setItem('copad-last-room', room);
let roomRevealTimer;
let roomSwitchGeneration = 0;
let roomSwitchTimer = 0;
let roomAwaitingRemoteSync = false;
const roomFragmentCache = new Map();
const roomScrollPositions = new Map();
function revealRoomContent() {
  document.documentElement.classList.remove('room-loading');
  $('.paper-wrap')?.classList.remove('room-switch-out');
  clearTimeout(roomRevealTimer);
  if (roomAwaitingRemoteSync) {
    roomAwaitingRemoteSync = false;
    editor.contentEditable = 'true';
    titleInput.disabled = false;
  }
}
if (hasRoom) roomRevealTimer = setTimeout(revealRoomContent, 3500);
let localRoomHtml = localStorage.getItem(`margin-note-${room}`);
let localRoomTitle = localStorage.getItem(`copad-title-${room}`) || '';
let hasLocalRoomCopy = localRoomHtml !== null || Boolean(localRoomTitle);
let roomCreator = params.get('creator') === '1' || hasLocalRoomCopy;
let roomName = hasRoom ? `ROOM ${room.toUpperCase()}` : 'NO ROOM OPEN';
$('#room-name').textContent = roomName;
// Paint a previously saved room immediately; IndexedDB and live-room sync can
// finish in the background without showing a blank note during room switches.
if (hasRoom && hasLocalRoomCopy) {
  if (localRoomHtml !== null) editor.innerHTML = sanitizeHTML(localRoomHtml);
  if (localRoomTitle) titleInput.value = localRoomTitle;
  if (localRoomHtml !== null) localRoomHtml = editor.innerHTML;
  updateEditorPlaceholder();
  revealRoomContent();
}
$('#date-stamp').textContent = new Intl.DateTimeFormat(undefined, { month: 'short', day: '2-digit', year: 'numeric' }).format(new Date()).toUpperCase();
$('#created-date').textContent = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date());

const profilePalette = [
  { name: 'Rust', color: '#bd563d' },
  { name: 'Sage', color: '#71877a' },
  { name: 'Clay', color: '#a78353' },
  { name: 'Slate', color: '#77849b' },
  { name: 'Plum', color: '#8b7184' },
  { name: 'Olive', color: '#777b56' },
  { name: 'Shimmer gold', color: '#f0c52e', gold: true, shimmer: true },
  { name: 'Shimmer pink', color: '#e887ad', shimmer: true },
];
const colors = profilePalette.map(({ color }) => color);
const normalizeProfileColor = (color) => ['#f1c95c', '#d2a344'].includes(String(color).toLowerCase()) ? '#f0c52e' : color;
function textContrast(hexColor) {
  const match = String(hexColor).match(/^#([\da-f]{6})$/i);
  if (!match) return '#fff';
  const rgb = match[1].match(/[\da-f]{2}/gi).map((channel) => Number.parseInt(channel, 16));
  return (rgb[0] * 299 + rgb[1] * 587 + rgb[2] * 114) / 1000 >= 155 ? '#302c25' : '#fff';
}
const goldColors = new Set(profilePalette.filter((item) => item.gold).map(({ color }) => color));
const shimmerColors = new Set(profilePalette.filter((item) => item.shimmer).map(({ color }) => color));
const shimmerLabelColors = new Map([['#f0c52e', '#5c4700'], ['#e887ad', '#70283f']]);
const colorFor = (name) => colors[[...name].reduce((sum, char) => sum + char.charCodeAt(0), 0) % colors.length];
let userName = localStorage.getItem('margin-name') || '';
let profileColor = normalizeProfileColor(localStorage.getItem('copad-profile-color'));
if (!colors.includes(profileColor)) profileColor = colorFor(userName || 'Writer');
localStorage.setItem('copad-profile-color', profileColor);
localStorage.removeItem('copad-avatar');
let nameReady;
const namePromise = new Promise((resolve) => { nameReady = resolve; });
const nameModal = $('#name-modal');
const nameInput = $('#name-input');
const nameSubmit = $('#name-submit');
let editingName = false;
let titleIsComposing = false;
if (!userName) nameModal.classList.remove('hidden');
else nameReady(userName);
function closeNameDialog() {
  if (!editingName) return;
  nameModal.classList.add('hidden');
  editingName = false;
}
$('#name-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const nextName = nameInput.value.trim().slice(0, 28);
  const wasEditing = editingName;
  userName = nextName;
  if (!userName) return;
  localStorage.setItem('margin-name', userName);
  updateProfileButton();
  refreshUnicodeMember();
  nameModal.classList.add('hidden');
  editingName = false;
  nameReady(userName);
  setAwarenessUser();
  renderPeople();
  updateLocalCursor();
  if (wasEditing) showToast('Your name has been updated');
});
$('#edit-name').addEventListener('click', () => {
  editingName = true;
  nameInput.value = userName;
  $('#welcome-title').textContent = 'Change your name';
  $('#name-help').textContent = 'Your updated name will appear beside your cursor and to everyone in this room.';
  nameSubmit.textContent = 'Save name';
  $('#name-footnote').textContent = 'YOU CAN CHANGE THIS ANYTIME.';
  $('#profile-color-setting').classList.remove('hidden');
  updateProfileColorPicker();
  $('#close-name').classList.remove('hidden');
  nameModal.classList.remove('hidden');
  requestAnimationFrame(() => { nameInput.focus(); nameInput.select(); });
});
$('#close-name').addEventListener('click', closeNameDialog);
nameModal.addEventListener('click', (event) => { if (editingName && event.target === nameModal) closeNameDialog(); });
$('#profile-color-options').addEventListener('click', (event) => {
  const choice = event.target.closest('[data-profile-color]');
  if (!choice) return;
  setProfileColor(choice.dataset.profileColor);
});

let doc = new Y.Doc();
let persistence = hasRoom ? new IndexeddbPersistence(`copad-${room}`, doc) : null;
let provider;
let sharedText;
let sharedTitle;
let undoManager;
let applyingRemote = false;
let soundOn = localStorage.getItem('copad-sound') !== 'off';
let keySoundContext;
let keySoundBuffers;
let keySoundLoad;
let lastKeySound = -1;
const activeKeySounds = new Set();
let remoteRenderQueued = false;
let documentRenderPending = false;
let localCursorMarker;
let localCursorHasPositioned = false;
let cursorFrame = 0;
let cursorVersionCache = '';
const cursorDocumentHistory = [];
const remoteCursorAnchors = new Map();
// Cursor positions are anchored to Y.Text items, rather than guessed from
// whole-document text offsets. Yjs keeps these positions stable as concurrent
// edits from multiple writers are integrated.
let localSelectionAnchors = null;
let localAnchorCacheKey = '';
const serializedHtmlCache = new WeakMap();
const voidHtmlTags = new Set(['AREA', 'BASE', 'BR', 'COL', 'EMBED', 'HR', 'IMG', 'INPUT', 'LINK', 'META', 'PARAM', 'SOURCE', 'TRACK', 'WBR']);
const editorOrigin = {};
let savedSelection = null;
let formattingAction = false;
let resetColorOnNextInput = false;
let pendingInlineInsertion = null;
let pendingEmptyEditorReset = false;
let markerMode = false;
// Hide the OS mouse pointer while the user is keyboard-typing in the note.
// The editor caret and collaborator carets are separate DOM elements and stay visible.
function hideSystemPointerForTyping() {
  if (!markerMode) document.documentElement.classList.add('copad-pointer-hidden');
}
function revealSystemPointer() {
  document.documentElement.classList.remove('copad-pointer-hidden');
}
document.addEventListener('pointermove', (event) => {
  if (event.pointerType === 'mouse' || event.pointerType === 'pen') revealSystemPointer();
}, { capture: true, passive: true });
document.addEventListener('pointerdown', revealSystemPointer, true);
let markerStrokeStart = null;
let selectedHighlightColor = localStorage.getItem('copad-highlight-color') || '#ffe17c';
if (!/^#[\da-f]{6}$/i.test(selectedHighlightColor)) selectedHighlightColor = '#ffe17c';
const cursors = new Map();
const peopleSnapshot = new Map();
const user = { name: userName || 'Writer', color: profileColor };

function createPersonAvatar(person, className) {
  const avatar = document.createElement('span');
  avatar.className = className;
  avatar.title = person.name || 'Writer';
  const normalizedColor = normalizeProfileColor(person.color);
  const avatarColor = colors.includes(normalizedColor) ? normalizedColor : colorFor(person.name || 'Writer');
  avatar.style.backgroundColor = avatarColor;
  avatar.style.color = textContrast(avatarColor);
  avatar.textContent = (person.name || 'W').slice(0, 1).toUpperCase();
  return avatar;
}
function updateProfileColorPicker() {
  const preview = $('#avatar-preview');
  if (preview) {
    preview.style.backgroundColor = profileColor;
    preview.style.color = textContrast(profileColor);
    preview.textContent = (userName || 'Y').slice(0, 1).toUpperCase();
  }
  const options = $('#profile-color-options');
  if (!options) return;
  options.replaceChildren(...profilePalette.map(({ name, color, gold, shimmer }) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `profile-color-swatch${gold ? ' gold-swatch' : ''}${shimmer && !gold ? ' pink-swatch' : ''}`;
    button.dataset.profileColor = color;
    button.title = name;
    button.setAttribute('aria-label', `${name} profile and caret color`);
    button.setAttribute('aria-pressed', String(profileColor === color));
    button.style.setProperty('--swatch-color', color);
    if (profileColor === color) button.classList.add('selected');
    return button;
  }));
}
function updateProfileButton() {
  const button = $('#edit-name');
  const avatar = $('#profile-button-avatar');
  if (!button || !avatar) return;
  avatar.textContent = (userName || 'Y').slice(0, 1).toUpperCase();
  avatar.style.backgroundColor = profileColor;
  avatar.style.color = textContrast(profileColor);
  button.title = `Edit ${userName || 'your'} name and color`;
  button.setAttribute('aria-label', `Edit ${userName || 'your'} name and color`);
}
function setProfileColor(nextColor) {
  if (!colors.includes(nextColor)) return;
  profileColor = nextColor;
  localStorage.setItem('copad-profile-color', profileColor);
  user.color = profileColor;
  setAwarenessUser();
  renderPeople();
  updateProfileColorPicker();
  updateProfileButton();
  refreshUnicodeMember();
  updateLocalCursor();
}
updateProfileButton();
updateProfileColorPicker();

function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('visible');
  clearTimeout(showToast.timeout);
  showToast.timeout = setTimeout(() => toast.classList.remove('visible'), 2200);
}
function updateEditorPlaceholder() {
  editor.classList.toggle('is-empty', !editor.textContent.trim() && !editor.querySelector('img,figure'));
}
function resetEmptyEditorToPlain() {
  if (editor.textContent.length || editor.querySelector('img,figure')) return false;
  editor.replaceChildren();
  savedSelection = null;
  const range = document.createRange();
  range.setStart(editor, 0);
  range.collapse(true);
  const selection = getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

const roomIndexKey = 'copad-room-history';
const unicodeBrowserKey = 'copad-browser-id';
let unicodeBrowserId = localStorage.getItem(unicodeBrowserKey);
if (!unicodeBrowserId || !/^[a-z\d_-]{16,80}$/i.test(unicodeBrowserId)) {
  unicodeBrowserId = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  localStorage.setItem(unicodeBrowserKey, unicodeBrowserId);
}
let unicodeReady = false;
let unicodeSummary = null;
let unicodeRooms = new Map();
const unicodeDeletedRooms = new Set();
const unicodeRoomCleanupInFlight = new Set();
const unicodeRoomCleanupDone = new Set();
const unicodeSyncTimers = new Map();
const unicodePendingRooms = new Map();
const unicodeRoomsInFlight = new Set();
let unicodeRetryTimer = 0;
let unicodePollTimer = 0;
let unicodePresenceTimer = 0;
let unicodeRefreshInFlight = false;
let unicodePresenceInFlight = false;
let unicodePresenceRefreshQueued = false;
let unicodePresenceServerWarningShown = false;
const unicodePresenceSessionId = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
const unicodeEndpoint = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/copad-unicode`;
function unicodeRequest(path, body, method = 'POST') {
  const search = path.includes('?') ? path.slice(path.indexOf('?')) : '';
  const action = path.replace(/\?.*$/, '').replace('/api/unicode/', '');
  const url = `${unicodeEndpoint}/${action}${search}`;
  return fetch(url, body === undefined ? { cache: 'no-store', headers: { Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}` } } : {
    method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}` }, body: JSON.stringify(body), cache: 'no-store',
  }).then(async (response) => {
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = result.error || 'UniCode request failed.';
      throw Object.assign(new Error(message), { status: response.status, deletedRoomId: result.deletedRoomId });
    }
    return result;
  });
}
function updateUnicodeSummary(summary) {
  unicodeSummary = summary;
  const newlyDeleted = [];
  for (const id of summary.deletedRoomIds || []) {
    if (!unicodeDeletedRooms.has(id)) newlyDeleted.push(id);
    unicodeDeletedRooms.add(id);
  }
  unicodeRooms = new Map((summary.rooms || []).filter((record) => !unicodeDeletedRooms.has(record.id)).map((record) => [record.id, record]));
  $('#unicode-code').textContent = summary.code;
  for (const id of newlyDeleted) void forgetDeletedRoomLocally(id);
  renderRoomHistory();
}
async function syncUnicodeRoom(record, refresh = true) {
  if (!unicodeReady || !record?.id) return;
  const id = record.id;
  unicodePendingRooms.set(id, record);
  if (unicodeRoomsInFlight.has(id)) return;
  unicodeRoomsInFlight.add(id);
  try {
    while (unicodePendingRooms.has(id)) {
      const queued = unicodePendingRooms.get(id);
      unicodePendingRooms.delete(id);
      await unicodeRequest('/api/unicode/room', {
        browserId: unicodeBrowserId, id, title: queued.title,
        name: userName || 'Writer', color: profileColor,
      });
    }
  } catch (error) {
    if (error.deletedRoomId) {
      unicodePendingRooms.delete(id);
      unicodeDeletedRooms.add(id);
      void forgetDeletedRoomLocally(id);
      return;
    }
    if (!unicodePendingRooms.has(id)) unicodePendingRooms.set(id, record);
    console.warn('Could not add this room to UniCode yet', error);
    scheduleUnicodeRetry();
  } finally {
    unicodeRoomsInFlight.delete(id);
    if (unicodePendingRooms.has(id)) scheduleUnicodeRetry();
  }
  if (refresh && !unicodePendingRooms.has(id)) {
    try { await refreshUnicodeRooms(); }
    catch (error) { console.warn('Room synced; UniCode list refresh will retry', error); }
  }
}
function scheduleUnicodeRetry() {
  if (!unicodeReady || unicodeRetryTimer) return;
  unicodeRetryTimer = setTimeout(() => {
    unicodeRetryTimer = 0;
    for (const record of unicodePendingRooms.values()) void syncUnicodeRoom(record, false);
  }, 5000);
}
function scheduleUnicodeRoomSync(record) {
  if (!unicodeReady) return;
  if (unicodeRooms.get(record?.id)?.title === record?.title) return;
  const previous = unicodeSyncTimers.get(record.id);
  if (previous) clearTimeout(previous);
  unicodeSyncTimers.set(record.id, setTimeout(() => {
    unicodeSyncTimers.delete(record.id);
    void syncUnicodeRoom(record);
  }, 650));
}
async function refreshUnicodeRooms() {
  if (!unicodeReady || unicodeRefreshInFlight) return;
  unicodeRefreshInFlight = true;
  try {
    const summary = await unicodeRequest(`/api/unicode/rooms?browserId=${encodeURIComponent(unicodeBrowserId)}`);
    const previous = JSON.stringify({
      code: unicodeSummary?.code,
      members: unicodeSummary?.members || [],
      rooms: [...unicodeRooms.values()],
      deletedRoomIds: [...unicodeDeletedRooms].sort(),
    });
    const next = JSON.stringify({
      code: summary.code,
      members: summary.members || [],
      rooms: summary.rooms || [],
      deletedRoomIds: [...(summary.deletedRoomIds || [])].sort(),
    });
    if (previous !== next) updateUnicodeSummary(summary);
  } finally {
    unicodeRefreshInFlight = false;
  }
}
async function heartbeatUnicodePresence() {
  if (!unicodeReady || !hasRoom) return;
  if (unicodePresenceInFlight) { unicodePresenceRefreshQueued = true; return; }
  const presenceRoom = room;
  unicodePresenceInFlight = true;
  try {
    await unicodeRequest('/api/unicode/presence', {
      browserId: unicodeBrowserId, sessionId: unicodePresenceSessionId, roomId: presenceRoom,
    });
    unicodePresenceServerWarningShown = false;
  } catch (error) {
    // A just-created room may need one room-list sync before it can be announced.
    const missingPresenceApi = error.status === 404 && /unicode endpoint not found/i.test(error.message);
    if (missingPresenceApi && !unicodePresenceServerWarningShown) {
      unicodePresenceServerWarningShown = true;
      console.error('This CoPad host is running an older room-presence server. Restart the CoPad launcher to refresh room locations.');
      showToast('Room locations are not syncing. Restart the CoPad host to update it.');
    } else if (error.status !== 404) {
      console.warn('Could not update UniCode room presence', error);
    }
  } finally {
    unicodePresenceInFlight = false;
    if (unicodePresenceRefreshQueued) {
      unicodePresenceRefreshQueued = false;
      if (hasRoom) queueMicrotask(() => void heartbeatUnicodePresence());
      else leaveUnicodePresence();
    }
  }
}
function leaveUnicodePresence() {
  if (!unicodeReady) return;
  const payload = JSON.stringify({ browserId: unicodeBrowserId, sessionId: unicodePresenceSessionId, leave: true });
  try {
    if (navigator.sendBeacon?.(`${unicodeEndpoint}/presence`, new Blob([payload], { type: 'application/json' }))) return;
  } catch { /* Fall back to keepalive fetch if the browser can't queue a beacon. */ }
  void fetch(`${unicodeEndpoint}/presence`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}` }, body: payload,
    cache: 'no-store', keepalive: true,
  }).catch(() => {});
}
function refreshUnicodeRoomsWhenVisible() {
  if (document.visibilityState !== 'visible') return;
  refreshUnicodeRooms().catch((error) => console.warn('Could not refresh UniCode rooms after returning', error));
  void heartbeatUnicodePresence();
}
document.addEventListener('visibilitychange', refreshUnicodeRoomsWhenVisible);
window.addEventListener('pageshow', refreshUnicodeRoomsWhenVisible);
async function initializeUnicode() {
  try {
    await namePromise;
    const summary = await unicodeRequest('/api/unicode/account', {
      browserId: unicodeBrowserId, name: userName || 'Writer', color: profileColor,
    });
    unicodeReady = true;
    updateUnicodeSummary(summary);
    const missingRooms = readRoomHistory().filter((record) => !unicodeRooms.has(record.id));
    await Promise.all(missingRooms.map((record) => syncUnicodeRoom(record, false)));
    await refreshUnicodeRooms();
    clearInterval(unicodePollTimer);
    clearInterval(unicodePresenceTimer);
    void heartbeatUnicodePresence();
    unicodePollTimer = setInterval(() => refreshUnicodeRooms().catch((error) => console.warn('Could not refresh UniCode rooms', error)), 2200);
    unicodePresenceTimer = setInterval(() => heartbeatUnicodePresence(), 4000);
  } catch (error) {
    console.warn('UniCode is not reachable yet', error);
    clearTimeout(initializeUnicode.retryTimer);
    initializeUnicode.retryTimer = setTimeout(initializeUnicode, 5000);
  }
}
function refreshUnicodeMember() {
  if (!unicodeReady) return;
  unicodeRequest('/api/unicode/account', { browserId: unicodeBrowserId, name: userName || 'Writer', color: profileColor })
    .then((summary) => updateUnicodeSummary(summary))
    .catch((error) => console.warn('Could not update UniCode profile', error));
}
$('#unicode-code').addEventListener('click', async () => {
  if (!unicodeSummary?.code) return;
  try { await navigator.clipboard.writeText(unicodeSummary.code); showToast('UniCode copied'); }
  catch { showToast(`Your UniCode is ${unicodeSummary.code}`); }
});
$('#unicode-link-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const code = form.elements.code.value.trim();
  if (!/^\d{6}$/.test(code)) return;
  button.disabled = true;
  try {
    const summary = await unicodeRequest('/api/unicode/link', {
      browserId: unicodeBrowserId, code, name: userName || 'Writer', color: profileColor,
    });
    unicodeReady = true;
    updateUnicodeSummary(summary);
    void heartbeatUnicodePresence();
    form.reset();
    showToast(`Joined house · ${summary.rooms.length} rooms`);
    const missingRooms = readRoomHistory().filter((record) => !unicodeRooms.has(record.id));
    void Promise.all(missingRooms.map((record) => syncUnicodeRoom(record, false)))
      .then(() => refreshUnicodeRooms())
      .catch((error) => console.warn('Joined house; room list refresh will retry', error));
  } catch (error) { showToast(error.message); }
  finally { button.disabled = false; }
});
let leavingDeletedRoom = false;
let localImageStorageNoticeShown = false;
function storeRoomSnapshotLocally(html = editor.innerHTML, title = titleInput.value) {
  if (!hasRoom || leavingDeletedRoom) return false;
  try {
    localStorage.setItem(`margin-note-${room}`, html);
    localStorage.setItem(`copad-title-${room}`, title);
    localRoomHtml = html;
    localRoomTitle = title;
    hasLocalRoomCopy = true;
    rememberRoom(title, false);
    return true;
  } catch (error) {
    if (!localImageStorageNoticeShown) {
      localImageStorageNoticeShown = true;
      showToast('Browser quick-save is full; live room sync is still active.');
    }
    console.warn('Could not save this room snapshot in browser storage', error);
    return false;
  }
}
function readRoomHistory() {
  try {
    const records = JSON.parse(localStorage.getItem(roomIndexKey) || '[]');
    return Array.isArray(records) ? records.filter((record) => record && typeof record.id === 'string') : [];
  } catch { return []; }
}
function safeRoomPresenceColor(color) { return /^#[\da-f]{6}$/i.test(String(color)) ? String(color) : '#71877a'; }
function migrateSavedRooms() {
  const records = readRoomHistory();
  const known = new Set(records.map((record) => record.id));
  let changed = false;
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (!key?.startsWith('margin-note-')) continue;
    const id = key.slice('margin-note-'.length);
    if (!id || known.has(id)) continue;
    records.push({ id, title: localStorage.getItem(`copad-title-${id}`) || `Room ${id.toUpperCase()}`, updatedAt: 0 });
    known.add(id);
    changed = true;
  }
  if (changed) localStorage.setItem(roomIndexKey, JSON.stringify(records));
}
function rememberRoom(title = '', render = true) {
  if (!hasRoom || leavingDeletedRoom || unicodeDeletedRooms.has(room)) return;
  migrateSavedRooms();
  const records = readRoomHistory();
  const previousIndex = records.findIndex((record) => record.id === room);
  const previous = previousIndex >= 0 ? records[previousIndex] : null;
  const label = String(title || previous?.title || 'Untitled room').trim().slice(0, 100) || 'Untitled room';
  const updated = { id: room, title: label, updatedAt: Date.now() };
  if (previousIndex >= 0) records[previousIndex] = updated;
  else records.unshift(updated);
  localStorage.setItem(roomIndexKey, JSON.stringify(records));
  scheduleUnicodeRoomSync(updated);
  if (render) renderRoomHistory();
}
function renderRoomHistory() {
  const historyList = $('#room-history');
  if (!historyList) return;
  const scrollTop = historyList.scrollTop;
  const scrollLeft = historyList.scrollLeft;
  historyList.replaceChildren();
  const localRecords = readRoomHistory().filter((record) => !unicodeDeletedRooms.has(record.id));
  const localIds = new Set(localRecords.map((record) => record.id));
  const records = localRecords.map((record) => {
    const shared = unicodeRooms.get(record.id);
    return shared ? { ...record, ...shared, title: shared.title || record.title, unicodeShared: true } : record;
  });
  for (const shared of unicodeRooms.values()) {
    if (!localIds.has(shared.id)) records.push({ ...shared, unicodeOnly: true, unicodeShared: true });
  }
  for (const record of records) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = `room-history-item${record.id === room ? ' active' : ''}`;
    item.title = `${record.title} · ${record.id}`;
    item.setAttribute('aria-current', record.id === room ? 'page' : 'false');
    const title = document.createElement('span');
    title.className = 'room-history-title';
    title.textContent = record.title;
    const code = document.createElement('span');
    code.className = 'room-history-code';
    code.textContent = record.id.toUpperCase();
    const meta = document.createElement('span');
    meta.className = 'room-meta-row';
    meta.append(code);
    const activePeopleById = new Map();
    for (const person of Array.isArray(record.presence) ? record.presence : []) {
      if (!person?.name) continue;
      const id = person.id || `${person.name}:${person.color || ''}`;
      activePeopleById.set(id, person);
    }
    if (record.id === room && !activePeopleById.has(unicodeBrowserId)) {
      activePeopleById.set(unicodeBrowserId, { id: unicodeBrowserId, name: userName || 'Writer', color: profileColor });
    }
    const activePeople = [...activePeopleById.values()];
    if (record.id === room) {
      const selfIndex = activePeople.findIndex((person) => person.id === unicodeBrowserId);
      if (selfIndex > 0) activePeople.unshift(activePeople.splice(selfIndex, 1)[0]);
    }
    const presenceStack = document.createElement('span');
    presenceStack.className = 'room-presence-stack';
    for (const person of activePeople.slice(0, 3)) {
      if (!person?.name) continue;
      const avatar = document.createElement('span');
      avatar.className = 'room-presence-avatar';
      avatar.textContent = Array.from(person.name)[0].toUpperCase();
      const personColor = safeRoomPresenceColor(person.color);
      avatar.style.setProperty('--presence-color', personColor);
      avatar.style.color = textContrast(personColor);
      avatar.title = `${person.name} is in this room`;
      avatar.setAttribute('aria-label', `${person.name} is in this room`);
      presenceStack.append(avatar);
    }
    if (activePeople.length > 3) {
      const more = document.createElement('span');
      more.className = 'room-presence-more';
      more.textContent = `+${activePeople.length - 3}`;
      more.title = activePeople.slice(3).map((person) => person.name).join(', ');
      presenceStack.append(more);
    }
    if (activePeople.length) meta.append(presenceStack);
    item.append(title, meta);
    if (record.unicodeShared && record.ownerName) {
      const creator = document.createElement('span');
      creator.className = 'room-created-by';
      creator.textContent = `Created by ${record.ownerName}`;
      item.append(creator);
    }
    item.addEventListener('click', () => {
      if (record.id === room) return;
      switchRoom(record.id, { title: record.title });
    });
    const row = document.createElement('div');
    row.className = 'room-history-row';
    row.append(item);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'room-delete-button';
    remove.title = record.unicodeShared ? `Delete ${record.title} for everyone in this UniCode house` : `Delete ${record.title} from this browser`;
    remove.setAttribute('aria-label', record.unicodeShared ? `Delete ${record.title} for everyone in this UniCode house` : `Delete ${record.title} from this browser`);
    remove.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3.5 5.5h13M7.2 5.5V3.4h5.6v2.1m2.8 0-.7 11H5.1l-.7-11m4 3v5m4-5v5"/></svg>';
    remove.addEventListener('click', (event) => { event.stopPropagation(); deleteRoomFromBrowser(record.id); });
    row.append(remove);
    historyList.append(row);
  }
  historyList.scrollTop = scrollTop;
  historyList.scrollLeft = scrollLeft;
}
function saveRoomLocally(showMessage = false) {
  if (!hasRoom || leavingDeletedRoom) return false;
  const html = sanitizeHTML(editor.innerHTML);
  const saved = storeRoomSnapshotLocally(html, titleInput.value);
  if (showMessage && saved) showToast('Room saved in this browser');
  return saved;
}
function deleteIndexedRoom(id) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(`copad-${id}`);
    request.onsuccess = () => {
      localStorage.removeItem(`copad-pending-delete-${id}`);
      resolve(true);
    };
    request.onerror = () => reject(request.error || new Error('Could not remove the saved room data.'));
    request.onblocked = () => {
      localStorage.setItem(`copad-pending-delete-${id}`, '1');
      showToast('Room removed here. Close its other tabs to finish clearing saved data.');
      resolve(false);
    };
  });
}
function retryPendingRoomDeletes() {
  const pending = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
    .filter((key) => key?.startsWith('copad-pending-delete-'));
  for (const key of pending) {
    const id = key.slice('copad-pending-delete-'.length);
    if (id) deleteIndexedRoom(id).catch(() => {});
  }
}
async function deleteRoomFromBrowser(id) {
  const record = readRoomHistory().find((item) => item.id === id) || unicodeRooms.get(id);
  if (!record) return;
  const shared = unicodeRooms.has(id);
  const question = shared
    ? `Delete “${record.title}” for everyone in this UniCode house?\n\nThis removes the room and its saved document for everyone linked to this house.`
    : `Delete “${record.title}” from this browser?\n\nThis removes its saved copy and room-history entry here.`;
  const confirmed = window.confirm(question);
  if (!confirmed) return;
  if (shared) {
    if (!unicodeReady) { showToast('UniCode is reconnecting. Try deleting again in a moment.'); return; }
    try {
      const summary = await unicodeRequest('/api/unicode/room', { browserId: unicodeBrowserId, id }, 'DELETE');
      updateUnicodeSummary(summary);
      showToast('Room deleted for everyone in this UniCode house');
    } catch (error) {
      showToast(error.message || 'Could not delete the shared room');
    }
    return;
  }
  try {
    await forgetDeletedRoomLocally(id);
    showToast('Room deleted from this browser');
  } catch (error) {
    console.error('Could not delete saved room', error);
    showToast('Could not delete that room. Close any other tabs using it and try again.');
  }
}
async function forgetDeletedRoomLocally(id) {
  if (!id || unicodeRoomCleanupDone.has(id) || unicodeRoomCleanupInFlight.has(id)) return;
  unicodeRoomCleanupInFlight.add(id);
  const wasCurrentRoom = id === room;
  try {
    const timer = unicodeSyncTimers.get(id);
    if (timer) clearTimeout(timer);
    unicodeSyncTimers.delete(id);
    unicodePendingRooms.delete(id);
    unicodeRooms.delete(id);
    roomFragmentCache.delete(id);
    roomScrollPositions.delete(id);
    if (wasCurrentRoom) {
      leavingDeletedRoom = true;
      editor.contentEditable = 'false';
      titleInput.disabled = true;
      try { provider?.awareness.setLocalState(null); } catch { }
      try { provider?.destroy(); } catch (error) { console.warn('Could not close deleted room connection', error); }
      provider = null;
      try { await persistence?.destroy(); } catch (error) { console.warn('Could not close deleted room storage', error); }
      persistence = null;
      try { doc.destroy(); } catch (error) { console.warn('Could not dispose of deleted room document', error); }
    }
    try { await deleteIndexedRoom(id); }
    catch (error) {
      localStorage.setItem(`copad-pending-delete-${id}`, '1');
      console.warn('Room removed; local database cleanup will retry', error);
    }
    localStorage.removeItem(`margin-note-${id}`);
    localStorage.removeItem(`copad-title-${id}`);
    const remaining = readRoomHistory().filter((record) => record.id !== id && !unicodeDeletedRooms.has(record.id));
    localStorage.setItem(roomIndexKey, JSON.stringify(remaining));
    const lastRoom = localStorage.getItem('copad-last-room');
    const nextRoom = remaining[0]?.id || [...unicodeRooms.keys()].find((roomId) => !unicodeDeletedRooms.has(roomId));
    if (lastRoom === id || wasCurrentRoom) {
      if (nextRoom) localStorage.setItem('copad-last-room', nextRoom);
      else localStorage.removeItem('copad-last-room');
    }
    renderRoomHistory();
    unicodeRoomCleanupDone.add(id);
    if (wasCurrentRoom) switchRoom(nextRoom || '', { historyMode: 'replace', discardCurrent: true });
  } catch (error) {
    console.error('Could not fully clean up deleted room on this browser', error);
  } finally {
    unicodeRoomCleanupInFlight.delete(id);
  }
}
retryPendingRoomDeletes();

function setAwarenessUser() {
  user.name = userName || 'Writer';
  user.color = profileColor;
  user.browserId = unicodeBrowserId;
  if (provider) provider.awareness.setLocalStateField('user', { ...user });
}

function applySharedTitleToInput() {
  if (!sharedTitle || titleIsComposing) return;
  const nextTitle = sharedTitle.toString();
  if (titleInput.value === nextTitle) return;
  const focused = document.activeElement === titleInput;
  const start = focused ? titleInput.selectionStart : null;
  const end = focused ? titleInput.selectionEnd : null;
  const direction = focused ? titleInput.selectionDirection : 'none';
  titleInput.value = nextTitle;
  if (focused && start !== null && end !== null) {
    const nextStart = Math.min(start, nextTitle.length);
    const nextEnd = Math.min(end, nextTitle.length);
    titleInput.setSelectionRange(nextStart, nextEnd, direction || 'none');
  }
}
function updateUndoControls() {
  const undoButton = $('[data-command="undo"]');
  const redoButton = $('[data-command="redo"]');
  if (undoButton) undoButton.disabled = !undoManager?.canUndo();
  if (redoButton) redoButton.disabled = !undoManager?.canRedo();
}
function performRoomHistoryAction(action) {
  if (!undoManager) return false;
  undoManager.stopCapturing();
  if (action === 'undo') undoManager.undo();
  else undoManager.redo();
  undoManager.stopCapturing();
  updateUndoControls();
  return true;
}
function handleHistoryBeforeInput(event) {
  if (!undoManager || (event.inputType !== 'historyUndo' && event.inputType !== 'historyRedo')) return;
  event.preventDefault();
  performRoomHistoryAction(event.inputType === 'historyUndo' ? 'undo' : 'redo');
}

function applyPendingRemoteEditorUpdate() {
  remoteRenderQueued = false;
  if (!documentRenderPending || !sharedText) return;
  applyingRemote = true;
  try {
    // The live DOM is from the previous document version, while sharedText
    // has already incorporated this remote transaction. Resolve the saved
    // relative anchors through Yjs before rebuilding the editor DOM.
    const hadEditorSelection = Boolean(captureSelection());
    const selection = hadEditorSelection ? (resolveLocalSelectionAnchors() || captureSelection()) : null;
    editor.innerHTML = sanitizeHTML(sharedText.toString());
    refreshCursorDocumentVersion();
    updateEditorPlaceholder();
    storeRoomSnapshotLocally(editor.innerHTML, titleInput.value);
    if (selection) {
      try { restoreSelection(selection); }
      catch { /* Keep the remote document even if a stale range cannot be restored. */ }
    }
  } finally {
    applyingRemote = false;
    documentRenderPending = false;
  }
  updateStats();
  updateLocalCursor();
  updateCursors();
  positionImageResizeHandle();
}
document.addEventListener('pointerdown', (event) => {
  // Flush a queued remote render before toolbar, room, or dialog actions read
  // the selection/document, while leaving editor clicks to their native hit test.
  if (documentRenderPending && !editor.contains(event.target)) applyPendingRemoteEditorUpdate();
}, true);

function connectRoom() {
  if (!hasRoom || !persistence) return;
  const generation = roomSwitchGeneration;
  const roomId = room;
  const roomDoc = doc;
  const roomPersistence = persistence;
  $('#sync-state').textContent = 'loading this device';
  editor.contentEditable = 'false';
  titleInput.disabled = true;
  roomPersistence.once('synced', () => {
    if (generation !== roomSwitchGeneration || roomDoc !== doc || roomPersistence !== persistence) return;
    sharedText = roomDoc.getText('html');
    sharedTitle = roomDoc.getText('title');
    const waitingForLiveDocument = roomAwaitingRemoteSync && !sharedText.length && !sharedTitle.length;
    if (!sharedText.length && roomCreator) sharedText.insert(0, localRoomHtml || editor.innerHTML);
    if (!sharedTitle.length && roomCreator) sharedTitle.insert(0, localRoomTitle || titleInput.value);
    const sharedHtml = sharedText.toString();
    const canonicalHtml = localRoomHtml !== null && sharedHtml === localRoomHtml ? sharedHtml : sanitizeHTML(sharedHtml);
    if (canonicalHtml !== sharedHtml) replaceSharedText(sharedText, canonicalHtml, editorOrigin);
    if (localRoomHtml !== canonicalHtml) editor.innerHTML = canonicalHtml;
    refreshCursorDocumentVersion();
    updateEditorPlaceholder();
    titleInput.value = sharedTitle.toString() || (waitingForLiveDocument ? localRoomTitle : '');
    undoManager = new Y.UndoManager([sharedText, sharedTitle], {
      trackedOrigins: new Set([editorOrigin]),
      captureTimeout: 500,
    });
    for (const eventName of ['stack-item-added', 'stack-item-updated', 'stack-item-popped', 'stack-cleared']) {
      undoManager.on(eventName, updateUndoControls);
    }
    updateUndoControls();
    if (waitingForLiveDocument) rememberRoom(titleInput.value, false);
    else if (localRoomHtml !== canonicalHtml || localRoomTitle !== sharedTitle.toString()) saveRoomLocally();
    else rememberRoom(titleInput.value, false);
    if (waitingForLiveDocument) {
      clearTimeout(roomRevealTimer);
      roomRevealTimer = setTimeout(revealRoomContent, 3500);
      editor.contentEditable = 'false';
      titleInput.disabled = true;
    } else {
      roomAwaitingRemoteSync = false;
      if (roomCreator || hasLocalRoomCopy || sharedText.length || sharedTitle.length) revealRoomContent();
      editor.contentEditable = 'true';
      titleInput.disabled = false;
    }
    sharedText.observe((event) => {
      if (generation !== roomSwitchGeneration || applyingRemote || event.transaction.origin === editorOrigin) return;
      documentRenderPending = true;
      if (!remoteRenderQueued) {
        remoteRenderQueued = true;
        queueMicrotask(() => { if (generation === roomSwitchGeneration) applyPendingRemoteEditorUpdate(); });
      }
    });
    sharedTitle.observe(() => {
      if (generation !== roomSwitchGeneration) return;
      applySharedTitleToInput();
      storeRoomSnapshotLocally(editor.innerHTML, sharedTitle.toString());
    });
    provider = createSupabaseProvider(`margin-${roomId}`, roomDoc, { user: { ...user } });
    provider.connect();
    const roomProvider = provider;
    roomProvider.on('synced', () => {
      if (generation !== roomSwitchGeneration) return;
      const needsFirstLocalCopy = roomAwaitingRemoteSync && !hasLocalRoomCopy;
      revealRoomContent();
      if (needsFirstLocalCopy) setTimeout(() => {
        if (generation === roomSwitchGeneration && hasRoom && !hasLocalRoomCopy) saveRoomLocally();
      }, 120);
    });
    roomProvider.awareness.on('change', ({ added, updated, removed }) => {
      if (generation !== roomSwitchGeneration || roomProvider !== provider) return;
      const states = roomProvider.awareness.getStates();
      const personChanged = updated.some((clientId) => {
        const nextPerson = states.get(clientId)?.user;
        return JSON.stringify(nextPerson ?? null) !== peopleSnapshot.get(clientId);
      });
      if (added.length || removed.length || personChanged) renderPeople();
      else updateCursors();
    });
    roomProvider.on('status', ({ status }) => {
      if (generation !== roomSwitchGeneration || roomProvider !== provider) return;
      const connected = status === 'connected';
      $('#sync-state').textContent = connected ? 'room is open' : 'reconnecting';
      $('#sync-state').previousElementSibling.classList.toggle('offline', !connected);
    });
    setAwarenessUser();
    namePromise.then(() => { if (generation === roomSwitchGeneration && roomProvider === provider) setAwarenessUser(); });
    roomProvider.awareness.setLocalStateField('cursor', null);
    renderPeople();
    updateStats();
  });
}

function captureSelection() {
  const selection = getSelection();
  if (!selection?.rangeCount || !editor.contains(selection.anchorNode)) return null;
  const range = selection.getRangeAt(0).cloneRange();
  return {
    start: textOffsetAtPoint(editor, range.startContainer, range.startOffset),
    end: textOffsetAtPoint(editor, range.endContainer, range.endOffset),
    startPoint: domPointPath(editor, range.startContainer, range.startOffset),
    endPoint: domPointPath(editor, range.endContainer, range.endOffset),
  };
}
function textOffsetAtPoint(root, target, targetOffset) {
  let total = 0;
  let found = false;
  const measure = (node) => node.nodeType === Node.TEXT_NODE
    ? node.length
    : [...node.childNodes].reduce((sum, child) => sum + measure(child), 0);
  const visit = (node) => {
    if (found) return;
    if (node === target) {
      if (node.nodeType === Node.TEXT_NODE) total += Math.max(0, Math.min(targetOffset, node.length));
      else [...node.childNodes].slice(0, Math.max(0, Math.min(targetOffset, node.childNodes.length))).forEach((child) => { total += measure(child); });
      found = true;
      return;
    }
    if (node.nodeType === Node.TEXT_NODE) { total += node.length; return; }
    for (const child of node.childNodes) { visit(child); if (found) return; }
  };
  visit(root);
  return total;
}
function domPointPath(root, node, offset) {
  if (!node || (node !== root && !root.contains(node))) return null;
  const path = [];
  while (node !== root) {
    const parent = node.parentNode;
    if (!parent) return null;
    path.unshift([...parent.childNodes].indexOf(node));
    node = parent;
  }
  return { path, offset };
}
function resolveDomPoint(root, point) {
  if (!point || !Array.isArray(point.path)) return null;
  let node = root;
  for (const index of point.path) {
    if (!node.childNodes[index]) return null;
    node = node.childNodes[index];
  }
  const maxOffset = node.nodeType === Node.TEXT_NODE ? node.length : node.childNodes.length;
  return [node, Math.max(0, Math.min(point.offset || 0, maxOffset))];
}
function textNodeAt(root, offset) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node; let remaining = Math.max(0, Number(offset) || 0); let lastTextPoint = null;
  while ((node = walker.nextNode())) {
    if (!node.length) continue;
    if (remaining === 0) return lastTextPoint || [node, 0];
    if (remaining < node.length) return [node, remaining];
    if (remaining === node.length) {
      lastTextPoint = [node, node.length];
      remaining = 0;
      continue;
    }
    remaining -= node.length;
    lastTextPoint = [node, node.length];
  }
  return lastTextPoint || [root, 0];
}
function rangeForPoint(root, node, offset) {
  const range = document.createRange();
  if (node === root) {
    const child = root.childNodes[Math.max(0, Math.min(offset, root.childNodes.length))];
    if (child) range.setStartBefore(child);
    else if (root.lastChild) range.setStartAfter(root.lastChild);
    else { range.selectNodeContents(root); range.collapse(true); return range; }
  } else {
    const maxOffset = node.nodeType === Node.TEXT_NODE ? node.length : node.childNodes.length;
    range.setStart(node, Math.max(0, Math.min(offset, maxOffset)));
  }
  range.collapse(true);
  return range;
}
function caretRectForPoint(root, range, node, offset) {
  const rect = range.getBoundingClientRect();
  if (rect.width || rect.height) return rect;

  // Empty blocks created by Enter (usually <p><br></p> or <div><br></div>)
  // have no Range rect in Chromium. Anchor the visual caret to that block
  // instead of leaving the named caret on the previous line.
  let block = node === root
    ? (root.childNodes[Math.min(offset, root.childNodes.length - 1)] || root.childNodes[Math.max(0, offset - 1)])
    : (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement);
  while (block && block !== root && !/^(P|DIV|H1|H2|H3|H4|LI|BLOCKQUOTE)$/.test(block.tagName)) block = block.parentElement;
  if (!block || block === root) return rect;
  const blockRect = block.getBoundingClientRect();
  if (!blockRect.height) return rect;
  const style = getComputedStyle(block);
  const paddingLeft = Number.parseFloat(style.paddingLeft) || 0;
  const paddingTop = Number.parseFloat(style.paddingTop) || 0;
  const fontSize = Number.parseFloat(style.fontSize) || 16;
  const lineHeight = style.lineHeight === 'normal' ? fontSize * 1.4 : (Number.parseFloat(style.lineHeight) || fontSize * 1.4);
  return { left: blockRect.left + paddingLeft, top: blockRect.top + paddingTop, width: 0, height: lineHeight };
}
function scrollCaretIntoPaper() {
  if (document.activeElement !== editor) return;
  const selection = getSelection();
  if (!selection?.rangeCount || !selection.isCollapsed || !editor.contains(selection.anchorNode)) return;
  const paper = $('#paper');
  const paperRect = paper.getBoundingClientRect();
  const range = rangeForPoint(editor, selection.anchorNode, selection.anchorOffset);
  const rect = caretRectForPoint(editor, range, selection.anchorNode, selection.anchorOffset);
  if (!rect.height && !rect.width) return;
  const visibleTop = paperRect.top + paper.clientTop + 18;
  const visibleBottom = paperRect.top + paper.clientTop + paper.clientHeight - 24;
  const caretBottom = rect.bottom ?? rect.top + rect.height;
  if (rect.top < visibleTop) paper.scrollTop += rect.top - visibleTop;
  else if (caretBottom > visibleBottom) paper.scrollTop += caretBottom - visibleBottom;
  updateLocalCursor();
}
function refreshCursorDocumentVersion() {
  const html = sharedText?.toString() || '';
  let hash = 2166136261;
  for (let index = 0; index < html.length; index += 1) hash = Math.imul(hash ^ html.charCodeAt(index), 16777619);
  const version = `${html.length}:${hash >>> 0}`;
  const text = editor.textContent || '';
  if (version !== cursorVersionCache) {
    const previous = cursorDocumentHistory.at(-1);
    if (previous) {
      for (const anchor of remoteCursorAnchors.values()) {
        if (anchor.version !== previous.version) continue;
        anchor.offset = mapCursorOffset(previous.text, text, anchor.offset);
        anchor.version = version;
      }
    }
    cursorVersionCache = version;
    cursorDocumentHistory.push({ version, text });
    let retainedCharacters = cursorDocumentHistory.reduce((total, item) => total + item.text.length, 0);
    while (cursorDocumentHistory.length > 40 || (cursorDocumentHistory.length > 1 && retainedCharacters > 2_000_000)) {
      retainedCharacters -= cursorDocumentHistory.shift().text.length;
    }
  } else {
    const current = cursorDocumentHistory.at(-1);
    if (current?.version === version) current.text = text;
  }
}
function cursorDocumentVersion() { return cursorVersionCache; }
function htmlTagEndFrom(markup, start = 0) {
  let index = start + 1;
  while (index < markup.length) {
    const close = markup.indexOf('>', index);
    if (close < 0) return markup.length;
    const doubleQuote = markup.indexOf('"', index);
    const singleQuote = markup.indexOf("'", index);
    const quoteIndex = Math.min(doubleQuote < 0 ? Infinity : doubleQuote, singleQuote < 0 ? Infinity : singleQuote);
    if (quoteIndex > close) return close + 1;
    const quote = markup[quoteIndex];
    const quoteEnd = markup.indexOf(quote, quoteIndex + 1);
    if (quoteEnd < 0) return markup.length;
    index = quoteEnd + 1;
  }
  return markup.length;
}
function htmlTagEnd(markup) { return htmlTagEndFrom(markup, 0); }
function htmlAttributesMatch(element, cached) {
  if (!cached?.attributes || cached.attributes.length !== element.attributes.length) return false;
  for (let index = 0; index < element.attributes.length; index += 1) {
    const attribute = element.attributes[index];
    if (cached.attributes[index][0] !== attribute.name || cached.attributes[index][1] !== attribute.value) return false;
  }
  return true;
}
function saveHtmlAttributes(element, cached) {
  cached.attributes = [...element.attributes].map((attribute) => [attribute.name, attribute.value]);
}
function openingTagHtmlLength(element) {
  let cached = serializedHtmlCache.get(element);
  if (htmlAttributesMatch(element, cached) && Number.isFinite(cached.openLength)) return cached.openLength;
  const shallowMarkup = element.cloneNode(false).outerHTML || '';
  const openLength = htmlTagEnd(shallowMarkup);
  cached ||= {};
  saveHtmlAttributes(element, cached);
  cached.openLength = openLength;
  cached.total = undefined;
  serializedHtmlCache.set(element, cached);
  return openLength;
}
function serializedTextHtmlLength(text) {
  const span = document.createElement('span');
  span.textContent = text;
  return span.innerHTML.length;
}
function serializedNodeHtmlLength(node) {
  const cached = serializedHtmlCache.get(node);
  if (node.nodeType === Node.TEXT_NODE) {
    if (cached?.kind === 'text' && cached.text === node.data) return cached.total;
    const total = serializedTextHtmlLength(node.data);
    serializedHtmlCache.set(node, { kind: 'text', text: node.data, total });
    return total;
  }
  if (node.nodeType === Node.ELEMENT_NODE) {
    const openLength = openingTagHtmlLength(node);
    const current = serializedHtmlCache.get(node);
    if (voidHtmlTags.has(node.tagName)) {
      current.total = openLength;
      current.children = [];
      current.childLengths = [];
      serializedHtmlCache.set(node, current);
      return openLength;
    }
    const children = [...node.childNodes];
    const childLengths = children.map(serializedNodeHtmlLength);
    const sameChildren = current.children?.length === children.length
      && children.every((child, index) => child === current.children[index] && childLengths[index] === current.childLengths[index]);
    if (sameChildren && Number.isFinite(current.total)) return current.total;
    const closingLength = `</${node.localName}>`.length;
    current.total = openLength + childLengths.reduce((sum, length) => sum + length, 0) + closingLength;
    current.children = children;
    current.childLengths = childLengths;
    serializedHtmlCache.set(node, current);
    return current.total;
  }
  if (node.nodeType === Node.COMMENT_NODE) return `<!--${node.data}-->`.length;
  return (node.outerHTML || '').length;
}
function htmlIndexAtDomPoint(point) {
  const resolved = resolveDomPoint(editor, point);
  if (!resolved) return null;
  const [target, offset] = resolved;
  let index = 0;
  let node = editor;
  for (const childIndex of point.path) {
    for (let sibling = 0; sibling < childIndex; sibling += 1) index += serializedNodeHtmlLength(node.childNodes[sibling]);
    node = node.childNodes[childIndex];
    if (node.nodeType === Node.ELEMENT_NODE) index += openingTagHtmlLength(node);
  }
  if (target === editor || target.nodeType === Node.ELEMENT_NODE) {
    for (let child = 0; child < offset; child += 1) index += serializedNodeHtmlLength(target.childNodes[child]);
  } else if (target.nodeType === Node.TEXT_NODE) {
    index += serializedTextHtmlLength(target.data.slice(0, offset));
  }
  return index;
}
function domPointAtHtmlIndex(requestedIndex) {
  const totalLength = editor.innerHTML.length;
  let remaining = Math.max(0, Math.min(totalLength, Number(requestedIndex) || 0));
  const textPointAtHtmlOffset = (node, htmlOffset) => {
    let low = 0;
    let high = node.data.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (serializedTextHtmlLength(node.data.slice(0, middle)) <= htmlOffset) low = middle;
      else high = middle - 1;
    }
    return [node, low];
  };
  const descend = (node, offset) => {
    if (node.nodeType === Node.TEXT_NODE) return textPointAtHtmlOffset(node, offset);
    let innerOffset = offset;
    if (node !== editor && node.nodeType === Node.ELEMENT_NODE) {
      const openLength = openingTagHtmlLength(node);
      if (innerOffset <= openLength) return [node, 0];
      innerOffset -= openLength;
    }
    for (let index = 0; index < node.childNodes.length; index += 1) {
      const child = node.childNodes[index];
      const childLength = serializedNodeHtmlLength(child);
      if (innerOffset === 0) return [node, index];
      if (innerOffset < childLength) return descend(child, innerOffset);
      if (innerOffset === childLength) {
        // Keep an anchor at the end of a text node inside that text node.
        // Some browsers measure a range on the parent boundary at the start
        // of the block, which made a collaborator's caret look stuck there.
        if (child.nodeType === Node.TEXT_NODE) return descend(child, childLength);
        return [node, index + 1];
      }
      innerOffset -= childLength;
    }
    return [node, node.childNodes.length];
  };
  try { return descend(editor, remaining); }
  catch { return null; }
}
function htmlOffsetsAtSelection(selection) {
  if (!selection?.startPoint || !selection?.endPoint) return null;
  const start = htmlIndexAtDomPoint(selection.startPoint);
  const end = htmlIndexAtDomPoint(selection.endPoint);
  return start === null || end === null ? null : { start, end };
}
function relativeAnchorAtHtmlOffset(offset, assoc = -1) {
  if (!sharedText || !Number.isFinite(offset)) return null;
  const index = Math.max(0, Math.min(sharedText.length, offset));
  try {
    // RelativePosition's documented JSON shape is safe to send through Yjs
    // awareness and is independent of this client's Yjs object instances.
    return JSON.parse(JSON.stringify(Y.createRelativePositionFromTypeIndex(sharedText, index, index === 0 ? 0 : assoc)));
  } catch { return null; }
}
function resolveRelativeHtmlOffset(relative) {
  if (!relative || !sharedText) return null;
  try {
    const position = Y.createAbsolutePositionFromRelativePosition(relative, doc);
    if (!position || position.type !== sharedText) return null;
    return Math.max(0, Math.min(sharedText.length, position.index));
  } catch { return null; }
}
function plainTextOffsetAtHtmlIndex(html, requestedIndex) {
  const limit = Math.max(0, Math.min(html.length, Number(requestedIndex) || 0));
  let index = 0;
  let plainOffset = 0;
  while (index < limit) {
    if (html[index] === '<') {
      // Skip markup without counting it as visible text. Respect quoted `>`
      // characters in attributes and comments in the sanitized document.
      index = Math.min(limit, htmlTagEndFrom(html, index));
      continue;
    }
    if (html[index] === '&') {
      const entity = /^&(?:#\d+|#x[\da-f]+|[a-z][\da-z]+);/i.exec(html.slice(index, index + 40));
      if (entity && index + entity[0].length <= limit) {
        const decoder = document.createElement('textarea');
        decoder.innerHTML = entity[0];
        plainOffset += decoder.value.length;
        index += entity[0].length;
        continue;
      }
    }
    plainOffset += 1;
    index += 1;
  }
  return Math.max(0, Math.min(editor.textContent.length, plainOffset));
}
function resolveLocalSelectionAnchors() {
  if (!localSelectionAnchors) return null;
  const startHtml = resolveRelativeHtmlOffset(localSelectionAnchors.start);
  const endHtml = resolveRelativeHtmlOffset(localSelectionAnchors.end);
  if (startHtml === null || endHtml === null) return null;
  // Keep transformed Yjs offsets in serialized HTML space until the new DOM
  // is rendered. Flattening to textContent loses paragraph boundaries, so a
  // caret in a lower row can otherwise be restored into an earlier row.
  return { startHtml, endHtml };
}
function mapCursorOffset(previousText, nextText, offset) {
  const position = Math.max(0, Math.min(Number(offset) || 0, previousText.length));
  let prefix = 0;
  const sharedLimit = Math.min(previousText.length, nextText.length);
  while (prefix < sharedLimit && previousText[prefix] === nextText[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < previousText.length - prefix && suffix < nextText.length - prefix
    && previousText[previousText.length - 1 - suffix] === nextText[nextText.length - 1 - suffix]) suffix += 1;
  const previousEnd = previousText.length - suffix;
  const nextEnd = nextText.length - suffix;
  if (position < prefix) return position;
  if (position >= previousEnd) return Math.max(0, Math.min(nextText.length, nextEnd + position - previousEnd));
  return Math.max(0, Math.min(nextText.length, prefix + Math.min(position - prefix, nextEnd - prefix)));
}
function currentCursorOffset(clientId, cursor) {
  const version = cursor?.version;
  if (!version) return Math.max(0, Math.min(editor.textContent.length, Number(cursor?.offset) || 0));
  const currentVersion = cursorDocumentVersion();
  if (version === currentVersion) {
    const offset = Math.max(0, Math.min(editor.textContent.length, Number(cursor.offset) || 0));
    remoteCursorAnchors.set(clientId, { offset, version: currentVersion, sourceOffset: offset, sourceVersion: version });
    return offset;
  }
  const existing = remoteCursorAnchors.get(clientId);
  if (existing?.version === currentVersion && existing.sourceVersion === version) {
    const sourceOffset = Math.max(0, Number(cursor.offset) || 0);
    if (sourceOffset !== existing.sourceOffset) {
      existing.offset = Math.max(0, Math.min(editor.textContent.length, existing.offset + sourceOffset - existing.sourceOffset));
      existing.sourceOffset = sourceOffset;
    }
    return existing.offset;
  }
  let historyIndex = -1;
  for (let index = cursorDocumentHistory.length - 1; index >= 0; index -= 1) {
    if (cursorDocumentHistory[index].version === version) { historyIndex = index; break; }
  }
  if (historyIndex < 0) return null;
  let offset = Math.max(0, Math.min(cursorDocumentHistory[historyIndex].text.length, Number(cursor.offset) || 0));
  for (let index = historyIndex + 1; index < cursorDocumentHistory.length; index += 1) {
    offset = mapCursorOffset(cursorDocumentHistory[index - 1].text, cursorDocumentHistory[index].text, offset);
  }
  offset = Math.max(0, Math.min(editor.textContent.length, offset));
  remoteCursorAnchors.set(clientId, { offset, version: currentVersion, sourceOffset: Math.max(0, Number(cursor.offset) || 0), sourceVersion: version });
  return offset;
}
function rangeForCursor(root, point, textOffset) {
  const [node, offset] = resolveDomPoint(root, point) || textNodeAt(root, textOffset || 0);
  return rangeForPoint(root, node, offset);
}
function restoreSelection(saved) {
  if (!saved) return;
  if (Number.isFinite(saved.startHtml) && Number.isFinite(saved.endHtml)
    && sharedText?.toString() === editor.innerHTML) {
    const startPoint = domPointAtHtmlIndex(saved.startHtml);
    const endPoint = domPointAtHtmlIndex(saved.endHtml);
    if (startPoint && endPoint) {
      const range = document.createRange();
      range.setStart(startPoint[0], startPoint[1]);
      range.setEnd(endPoint[0], endPoint[1]);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }
  }
  const safePoint = (point, textOffset) => {
    const resolved = resolveDomPoint(editor, point);
    if (resolved && !(resolved[0].nodeType === Node.TEXT_NODE && !resolved[0].length)
      && textOffsetAtPoint(editor, resolved[0], resolved[1]) === textOffset) return resolved;
    return textNodeAt(editor, textOffset);
  };
  const [startNode, startOffset] = safePoint(saved.startPoint, saved.start);
  const [endNode, endOffset] = safePoint(saved.endPoint, saved.end);
  const range = document.createRange();
  range.setStart(startNode, startOffset); range.setEnd(endNode, endOffset);
  const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
}
function markChanged() {
  if (applyingRemote || !sharedText) return;
  const selectionBeforeCleanup = captureSelection();
  const html = sanitizeHTML(editor.innerHTML);
  if (html !== editor.innerHTML) {
    editor.innerHTML = html;
    // Sanitizing pasted rich text can rebuild nodes and detach the browser's
    // native selection. Restore by text offset so the caret stays after the
    // pasted content instead of jumping to the start or a matching old path.
    if (selectionBeforeCleanup) restoreSelection(selectionBeforeCleanup);
  }
  updateEditorPlaceholder();
  storeRoomSnapshotLocally(html, titleInput.value);
  replaceSharedText(sharedText, html, editorOrigin);
  refreshCursorDocumentVersion();
  $('#detail-edited').textContent = 'Just now';
  updateStats();
  updateLocalCursor();
  if (provider) scheduleCursorUpdate();
}
function replaceSharedText(shared, next, origin) {
  const previous = shared.toString();
  if (previous === next) return;
  let prefix = 0;
  const limit = Math.min(previous.length, next.length);
  while (prefix < limit && previous[prefix] === next[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < previous.length - prefix && suffix < next.length - prefix
    && previous[previous.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix += 1;
  doc.transact(() => {
    if (previous.length > prefix + suffix) shared.delete(prefix, previous.length - prefix - suffix);
    const inserted = next.slice(prefix, next.length - suffix);
    if (inserted) shared.insert(prefix, inserted);
  }, origin);
}
function updateStats() {
  const text = editor.innerText.trim();
  const words = text ? text.split(/\s+/).filter(Boolean).length : 0;
  const chars = text.replace(/\s/g, '').length;
  $('#word-count').textContent = `${words.toLocaleString()} ${words === 1 ? 'word' : 'words'}`;
  $('#character-count').textContent = `${chars.toLocaleString()} ${chars === 1 ? 'character' : 'characters'}`;
  $('#read-time').textContent = `${Math.max(1, Math.ceil(words / 220))} min read`;
}

function updateLocalCursor() {
  const selection = captureSelection();
  const collapsed = Boolean(selection && selection.start === selection.end);
  const isFocused = document.activeElement === editor;
  const useNamedCaret = collapsed && isFocused && Boolean(editor.textContent.trim());
  editor.classList.toggle('copad-custom-caret', useNamedCaret);

  const browserSelection = getSelection();
  const caretPoint = collapsed && browserSelection?.rangeCount
    ? domPointPath(editor, browserSelection.anchorNode, browserSelection.anchorOffset)
    : null;
  if (selection && sharedText) {
    const cacheKey = `${cursorDocumentVersion()}|${JSON.stringify(selection.startPoint)}|${selection.start}|${JSON.stringify(selection.endPoint)}|${selection.end}`;
    if (cacheKey !== localAnchorCacheKey) {
      const offsets = htmlOffsetsAtSelection(selection);
      localSelectionAnchors = offsets ? {
        start: relativeAnchorAtHtmlOffset(offsets.start, -1),
        end: relativeAnchorAtHtmlOffset(offsets.end, selection.start === selection.end ? -1 : 1),
        startPoint: selection.startPoint,
        endPoint: selection.endPoint,
      } : null;
      localAnchorCacheKey = cacheKey;
    }
  } else if (!selection) {
    localSelectionAnchors = null;
    localAnchorCacheKey = '';
  }
  if (provider) {
    const previous = provider.awareness.getLocalState()?.cursor;
    const next = selection && collapsed && isFocused
      ? {
        offset: selection.start,
        point: caretPoint,
        version: cursorDocumentVersion(),
        relative: localSelectionAnchors?.end || null,
      }
      : null;
    if (JSON.stringify(previous ?? null) !== JSON.stringify(next)) {
      provider.awareness.setLocalStateField('cursor', next);
    }
  }

  if (useNamedCaret) {
    if (!localCursorMarker) {
      localCursorMarker = document.createElement('div');
      localCursorMarker.className = 'remote-cursor local-cursor cursor-first-position';
      localCursorMarker.innerHTML = '<span class="cursor-stem"></span><span class="cursor-tag"></span>';
      $('#paper').append(localCursorMarker);
    }
    const [cursorNode, cursorOffset] = caretPoint
      ? [browserSelection.anchorNode, browserSelection.anchorOffset]
      : textNodeAt(editor, selection.end);
    const range = rangeForPoint(editor, cursorNode, cursorOffset);
    const rect = caretRectForPoint(editor, range, cursorNode, cursorOffset);
    if (rect.width || rect.height) {
      editor.classList.add('copad-custom-caret');
      const paper = $('#paper');
      placeCursorMarker(localCursorMarker, rect.left - paper.getBoundingClientRect().left + paper.scrollLeft, rect.top - paper.getBoundingClientRect().top + paper.scrollTop);
      localCursorMarker.querySelector('.cursor-tag').textContent = userName || 'You';
    } else localCursorMarker.classList.add('hidden');
  } else if (localCursorMarker) localCursorMarker.classList.add('hidden');
}
function placeCursorMarker(marker, x, y) {
  marker.classList.remove('hidden');
  marker.style.transform = `translate3d(${x}px,${y}px,0)`;
  if (marker === localCursorMarker && !localCursorHasPositioned) {
    localCursorHasPositioned = true;
    requestAnimationFrame(() => marker.classList.remove('cursor-first-position'));
  }
  const color = marker.dataset.color || profileColor;
  marker.style.setProperty('--cursor-color', color);
  marker.style.setProperty('--cursor-label-ink', shimmerLabelColors.get(color) || '#fff');
  marker.classList.toggle('shimmer-cursor', shimmerColors.has(color));
}
function renderPeople() {
  const list = $('#people-list');
  if (!list) return;
  const states = provider?.awareness.getStates() || new Map();
  const people = [...states.entries()].filter(([clientId, state]) => clientId !== doc.clientID && state.user);
  people.unshift([doc.clientID, { user: { name: userName || 'Writer', color: profileColor } }]);
  peopleSnapshot.clear();
  list.replaceChildren();
  for (const [clientId, state] of people) {
    const person = state.user || {};
    peopleSnapshot.set(clientId, JSON.stringify(person));
    const row = document.createElement('div');
    row.className = 'person-row';
    row.append(createPersonAvatar(person, 'person-avatar'));
    const info = document.createElement('span');
    info.className = 'person-info';
    const name = document.createElement('span');
    name.className = 'person-name';
    name.textContent = `${person.name || 'Writer'}${clientId === doc.clientID ? ' (you)' : ''}`;
    const stateLabel = document.createElement('span');
    stateLabel.className = 'person-state';
    stateLabel.textContent = 'IN THE ROOM';
    info.append(name, stateLabel);
    const live = document.createElement('span');
    live.className = 'person-live';
    row.append(info, live);
    list.append(row);
  }
  updateCursors();
}
function updateCursors() {
  // A remote Y.Text transaction has landed, but the matching HTML has not
  // been painted yet. Keep the last stable caret frame until the DOM catches up.
  if (documentRenderPending) return;
  const states = provider?.awareness.getStates() || new Map();
  const present = new Set();
  const paper = $('#paper');
  const paperRect = paper.getBoundingClientRect();
  for (const [clientId, state] of states) {
    if (clientId === doc.clientID || !state.user) continue;
    present.add(clientId);
    const existingMarker = cursors.get(clientId);
    if (!state.cursor) {
      remoteCursorAnchors.delete(clientId);
      existingMarker?.classList.add('hidden');
      continue;
    }
    const cursorVersionIsCurrent = !state.cursor.version || state.cursor.version === cursorDocumentVersion();
    const relativeHtmlOffset = resolveRelativeHtmlOffset(state.cursor.relative);
    const hasRelativePosition = relativeHtmlOffset !== null;
    if (state.cursor.relative && !hasRelativePosition) {
      existingMarker?.classList.add('hidden');
      continue;
    }
    if (hasRelativePosition) remoteCursorAnchors.delete(clientId);
    const targetCursorOffset = hasRelativePosition
      ? plainTextOffsetAtHtmlIndex(sharedText.toString(), relativeHtmlOffset)
      : currentCursorOffset(clientId, state.cursor);
    if (targetCursorOffset === null) continue;
    let cursorNode; let cursorOffset; let range;
    try {
      // When both clients see the same rendered document, the DOM point keeps
      // block boundaries (including empty rows) exact. After another person
      // edits, map the transformed Yjs HTML anchor back into the current DOM;
      // a flattened text offset loses paragraph boundaries and can make an
      // idle caret jump between adjacent rows on every render.
      const sharedHtml = sharedText.toString();
      const anchoredPoint = hasRelativePosition && sharedHtml === editor.innerHTML
        ? domPointAtHtmlIndex(relativeHtmlOffset)
        : null;
      const savedPoint = cursorVersionIsCurrent ? resolveDomPoint(editor, state.cursor.point) : null;
      [cursorNode, cursorOffset] = anchoredPoint || savedPoint || textNodeAt(editor, targetCursorOffset);
      range = rangeForPoint(editor, cursorNode, cursorOffset);
    } catch { existingMarker?.classList.add('hidden'); continue; }
    const rect = caretRectForPoint(editor, range, cursorNode, cursorOffset);
    const editorRect = editor.getBoundingClientRect();
    if ((!rect.height && !rect.width) || rect.top < editorRect.top - 4 || rect.top > editorRect.bottom + 4) {
      existingMarker?.classList.add('hidden');
      continue;
    }
    let marker = cursors.get(clientId);
    if (!marker) {
      marker = document.createElement('div');
      marker.className = 'remote-cursor cursor-first-position';
      marker.innerHTML = '<span class="cursor-stem"></span><span class="cursor-tag"></span>';
      paper.append(marker);
      cursors.set(clientId, marker);
    }
    const normalizedColor = normalizeProfileColor(state.user.color);
    const color = colors.includes(normalizedColor) ? normalizedColor : colorFor(state.user.name || 'Writer');
    marker.classList.remove('hidden');
    marker.dataset.color = color;
    marker.style.setProperty('--cursor-color', color);
    marker.style.setProperty('--cursor-label-ink', shimmerLabelColors.get(color) || '#fff');
    marker.classList.toggle('shimmer-cursor', shimmerColors.has(color));
    marker.querySelector('.cursor-tag').textContent = state.user.name || 'Writer';
    marker.style.transform = `translate3d(${rect.left - paperRect.left + paper.scrollLeft}px,${rect.top - paperRect.top + paper.scrollTop}px,0)`;
    if (marker.classList.contains('cursor-first-position')) {
      // Let the browser paint the caret at its real location before enabling
      // glide transitions, so a joining/reloading peer never sees it fly in
      // from the paper's top-left corner.
      requestAnimationFrame(() => requestAnimationFrame(() => marker.classList.remove('cursor-first-position')));
    }
  }
  for (const [clientId, marker] of cursors) if (!present.has(clientId)) { marker.remove(); cursors.delete(clientId); remoteCursorAnchors.delete(clientId); }
}
function scheduleCursorUpdate() {
  if (cursorFrame) return;
  cursorFrame = requestAnimationFrame(() => {
    cursorFrame = 0;
    updateCursors();
  });
}
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])); }
function readableHighlightInk(background) {
  const value = String(background || '').trim();
  let channels = null;
  const hex = value.match(/^#([\da-f]{3}|[\da-f]{6})$/i);
  if (hex) {
    const digits = hex[1].length === 3 ? [...hex[1]].map((digit) => digit + digit).join('') : hex[1];
    channels = [0, 2, 4].map((offset) => parseInt(digits.slice(offset, offset + 2), 16));
  } else {
    const rgb = value.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*[\d.]+)?\s*\)$/i);
    if (rgb && rgb.slice(1, 4).every((channel) => Number(channel) <= 255)) channels = rgb.slice(1, 4).map(Number);
  }
  if (!channels) return null;
  const luminance = channels.map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  }).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
  // Reuse CoPad's normal paper inks instead of introducing pure black/white.
  const darkInk = '#4e5149';
  const lightInk = '#e3dfd4';
  const inkLuminance = (color) => {
    const rgb = color.slice(1).match(/.{2}/g).map((part) => parseInt(part, 16) / 255);
    return rgb.map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
      .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
  };
  const contrast = (ink) => {
    const inkLight = inkLuminance(ink);
    return (Math.max(luminance, inkLight) + 0.05) / (Math.min(luminance, inkLight) + 0.05);
  };
  return contrast(darkInk) >= contrast(lightInk) ? darkInk : lightInk;
}
function sanitizeHTML(html) {
  const parsed = new DOMParser().parseFromString(String(html), 'text/html');
  const allowed = new Set(['P', 'BR', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'H1', 'H2', 'H3', 'H4', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'SPAN', 'MARK', 'FONT', 'DIV', 'FIGURE', 'IMG']);
  const dangerous = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'MATH']);
  const safeImageSource = (value) => /^data:image\/(?:png|jpe?g|webp|gif);base64,[\da-z+/]+=*$/i.test(value || '') && value.length <= 1_500_000;
  const safeColor = (value) => {
    const normalized = value.replace(/\s+/g, ' ').trim();
    if (/^#[\da-f]{3}(?:[\da-f]{3})?$/i.test(normalized)) return true;
    const rgb = normalized.match(/^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i);
    return Boolean(rgb && rgb.slice(1).every((channel) => Number(channel) <= 255));
  };
  for (const element of [...parsed.body.querySelectorAll('*')].reverse()) {
    if (dangerous.has(element.tagName)) { element.remove(); continue; }
    if (!allowed.has(element.tagName)) { element.replaceWith(...element.childNodes); continue; }
    if (element.tagName === 'FIGURE' && element.getAttribute('data-copad-image') === 'true') {
      const attrs = [...element.attributes];
      const markedAsDragArtifact = attrs.some((attribute) => /^(?:data-.*(?:ghost|clone)|id|class)$/i.test(attribute.name)
        && /(?:ghost|clone|drag-preview)/i.test(attribute.value));
      const style = element.getAttribute('style') || '';
      const hasTransientDragStyle = /(?:^|;)\s*(?:translate|will-change|pointer-events)\s*:/i.test(style)
        || /(?:^|;)\s*(?:position\s*:\s*(?:absolute|fixed)|opacity\s*:\s*0(?:\D|$)|visibility\s*:\s*hidden)\s*(?:;|$)/i.test(style);
      if (markedAsDragArtifact || hasTransientDragStyle) { element.remove(); continue; }
    }
    if (element.tagName === 'IMG' && !safeImageSource(element.getAttribute('src'))) { element.remove(); continue; }
    for (const attribute of [...element.attributes]) {
      if (element.tagName === 'IMG' && attribute.name === 'src' && safeImageSource(attribute.value)) continue;
      if (element.tagName === 'IMG' && attribute.name === 'alt') { element.setAttribute('alt', attribute.value.slice(0, 180)); continue; }
      if (element.tagName === 'FIGURE' && attribute.name === 'data-copad-image' && attribute.value === 'true') continue;
      if (element.tagName === 'DIV' && attribute.name === 'data-copad-image-row' && attribute.value === 'true') continue;
      if (element.tagName === 'FIGURE' && attribute.name === 'data-align' && ['left', 'center', 'right'].includes(attribute.value)) continue;
      if (element.tagName === 'FIGURE' && attribute.name === 'contenteditable' && attribute.value === 'false') continue;
      if (element.tagName === 'FIGURE' && attribute.name === 'draggable' && attribute.value === 'true') continue;
      if (element.tagName === 'IMG' && attribute.name === 'draggable' && attribute.value === 'false') continue;
      if (element.tagName === 'SPAN' && attribute.name === 'data-copad-heading' && /^h[1-4]$/.test(attribute.value)) continue;
      if (element.tagName === 'FONT' && attribute.name === 'color' && safeColor(attribute.value)) continue;
      if (element.tagName === 'FONT' && attribute.name === 'face' && ['DM Mono', 'IBM Plex Mono', 'DM Sans'].includes(attribute.value)) continue;
      if (attribute.name === 'style') {
        const safe = [];
        for (const declaration of element.style) {
          const value = element.style.getPropertyValue(declaration).trim();
          if ((declaration === 'color' || declaration === 'background-color') && safeColor(value)) safe.push(`${declaration}:${value}`);
          if (element.tagName === 'FIGURE' && declaration === 'width' && /^(?:\d{2,4}(?:\.\d+)?px|(?:(?:[1-9]|[1-9]\d)(?:\.\d+)?|100(?:\.0+)?)%)$/i.test(value)) safe.push(`width:${value}`);
          if (element.tagName === 'FIGURE' && declaration === 'transform' && /^rotate\(-?\d{1,3}deg\)$/i.test(value)) safe.push(`transform:${value}`);
        }
        if (safe.length) element.setAttribute('style', safe.join(';')); else element.removeAttribute('style');
        continue;
      }
      element.removeAttribute(attribute.name);
    }
    // Highlight foreground follows the highlight shade, not the page theme.
    // Explicit text-color spans inside a mark still override this inherited ink.
    const hasExplicitTextColorParent = (() => {
      let parent = element.parentElement;
      while (parent && parent !== parsed.body) {
        if (parent.style?.color && safeColor(parent.style.color)) return true;
        parent = parent.parentElement;
      }
      return false;
    })();
    if (element.tagName === 'MARK' && !element.style.backgroundColor) element.style.backgroundColor = '#efe2a6';
    if (element.tagName === 'MARK' && element.style.backgroundColor) {
      if (hasExplicitTextColorParent) element.style.removeProperty('color');
      else {
        const ink = readableHighlightInk(element.style.backgroundColor);
        if (ink) element.style.color = ink;
      }
    }
  }
  for (const figure of parsed.body.querySelectorAll('figure[data-copad-image="true"]')) {
    figure.setAttribute('draggable', 'true');
    figure.querySelectorAll('img').forEach((image) => image.setAttribute('draggable', 'false'));
  }
  for (const row of [...parsed.body.querySelectorAll('div[data-copad-image-row="true"]')]) {
    const images = [...row.children].filter((child) => child.matches('figure[data-copad-image="true"]'));
    if (!images.length) { row.remove(); continue; }
    if (images.length === 1) { images[0].style.removeProperty('width'); row.replaceWith(images[0]); continue; }
    if (images.length > 3) {
      const replacement = document.createDocumentFragment();
      for (let index = 0; index < images.length; index += 3) {
        const nextRow = document.createElement('div');
        nextRow.dataset.copadImageRow = 'true';
        const group = images.slice(index, index + 3);
        group.forEach((figure) => { figure.style.width = `${100 / group.length}%`; nextRow.append(figure); });
        replacement.append(nextRow);
      }
      row.replaceWith(replacement);
    } else if (!images.every((figure) => figure.style.width)) {
      images.forEach((figure) => { figure.style.width = `${100 / images.length}%`; });
    }
  }
  return parsed.body.innerHTML;
}
const MAX_IMAGE_FILE_BYTES = 15 * 1024 * 1024;
const MAX_SYNC_IMAGE_BYTES = 900 * 1024;
function readBlobAsDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error || new Error('Could not read image'));
    reader.readAsDataURL(blob);
  });
}
async function compressImageForRoom(file) {
  if (!file?.type?.startsWith('image/')) throw new Error('Choose an image file');
  if (file.size > MAX_IMAGE_FILE_BYTES) throw new Error('That image is too large. Choose one under 15 MB.');
  if (file.type === 'image/gif' && file.size <= MAX_SYNC_IMAGE_BYTES) return readBlobAsDataUrl(file);
  let bitmap;
  if (typeof createImageBitmap === 'function') bitmap = await createImageBitmap(file);
  else {
    const objectUrl = URL.createObjectURL(file);
    const image = new Image();
    await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = () => reject(new Error('That image could not be opened')); image.src = objectUrl; });
    bitmap = { width: image.naturalWidth, height: image.naturalHeight, image, close: () => URL.revokeObjectURL(objectUrl) };
  }
  try {
    let scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext('2d', { alpha: true }); context.drawImage(bitmap.image || bitmap, 0, 0, canvas.width, canvas.height);
      for (const quality of [.84, .76, .68, .6]) {
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', quality));
        if (blob && blob.size <= MAX_SYNC_IMAGE_BYTES) return readBlobAsDataUrl(blob);
      }
      scale *= .78;
    }
  } finally { bitmap.close(); }
  throw new Error('Could not compress that image enough to share. Try a smaller image.');
}
function fragmentHasContent(fragment) { return Boolean(fragment.textContent.length || fragment.querySelector('br,img,figure')); }
function firstCaretPoint(block) {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT); const text = walker.nextNode();
  if (text) return [text, 0];
  const child = block.querySelector('p,li,h1,h2,h3,h4,blockquote'); return [child || block, 0];
}
function insertImageBlock(dataUrl, altText = 'Pasted image', selectionSnapshot = null) {
  undoManager?.stopCapturing();
  editor.focus(); if (selectionSnapshot) restoreSelection(selectionSnapshot);
  let selection = getSelection();
  let range = selection?.rangeCount && editor.contains(selection.anchorNode) ? selection.getRangeAt(0).cloneRange() : null;
  if (!range) { range = document.createRange(); range.selectNodeContents(editor); range.collapse(false); }
  if (!range.collapsed) { range.deleteContents(); range.collapse(true); }
  let block = range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer : range.startContainer.parentElement;
  while (block && block !== editor && !['P', 'H1', 'H2', 'H3', 'H4', 'BLOCKQUOTE', 'DIV', 'LI', 'UL', 'OL'].includes(block.tagName)) block = block.parentElement;
  if (!block || !editor.contains(block)) block = editor;
  if (block.tagName === 'LI' && ['UL', 'OL'].includes(block.parentElement?.tagName)) block = block.parentElement;
  const beforeRange = range.cloneRange(); beforeRange.selectNodeContents(block); beforeRange.setEnd(range.startContainer, range.startOffset);
  const afterRange = range.cloneRange(); afterRange.selectNodeContents(block); afterRange.setStart(range.startContainer, range.startOffset);
  const before = beforeRange.cloneContents(); const after = afterRange.cloneContents();
  const figure = document.createElement('figure'); figure.dataset.copadImage = 'true'; figure.contentEditable = 'false'; figure.draggable = true; figure.style.width = '560px';
  const image = document.createElement('img'); image.src = dataUrl; image.alt = altText.slice(0, 180); image.draggable = false; figure.append(image);
  const parent = block === editor ? editor : block.parentNode; const reference = block === editor ? null : block.nextSibling;
  if (block !== editor) block.remove(); else editor.replaceChildren();
  let afterCaretBlock = null;
  if (block === editor) {
    for (const node of [...before.childNodes]) editor.append(node);
    editor.append(figure);
    if (fragmentHasContent(after)) { const nodes = [...after.childNodes]; afterCaretBlock = nodes.find((node) => node.nodeType === Node.ELEMENT_NODE) || null; for (const node of nodes) editor.append(node); }
  } else {
    if (fragmentHasContent(before)) { const beforeBlock = block.cloneNode(false); beforeBlock.append(before); parent.insertBefore(beforeBlock, reference); }
    parent.insertBefore(figure, reference);
    if (fragmentHasContent(after)) { afterCaretBlock = block.cloneNode(false); afterCaretBlock.append(after); parent.insertBefore(afterCaretBlock, reference); }
  }
  if (!afterCaretBlock) { afterCaretBlock = document.createElement('p'); afterCaretBlock.append(document.createElement('br')); if (block === editor) editor.append(afterCaretBlock); else parent.insertBefore(afterCaretBlock, reference); }
  const [caretNode, caretOffset] = firstCaretPoint(afterCaretBlock); const caret = document.createRange(); caret.setStart(caretNode, caretOffset); caret.collapse(true);
  selection = getSelection(); selection.removeAllRanges(); selection.addRange(caret); savedSelection = null;
  const savedCaret = captureSelection(); markChanged(); undoManager?.stopCapturing(); restoreSelection(savedCaret); updateLocalCursor();
}
async function insertImageFile(file, selectionSnapshot = captureSelection()) {
  const generation = roomSwitchGeneration;
  const targetRoom = room;
  try { showToast('Preparing image…'); const dataUrl = await compressImageForRoom(file); if (generation !== roomSwitchGeneration || targetRoom !== room) return; insertImageBlock(dataUrl, file.name.replace(/\.[^.]+$/, '') || 'Pasted image', selectionSnapshot); showToast('Image added. Resize from its corner, or drag it onto another image to make a row.'); }
  catch (error) { showToast(error.message || 'Could not add that image'); }
}
function selectionRange(snapshot = captureSelection()) {
  if (!snapshot) return null;
  restoreSelection(snapshot); const selection = getSelection(); return selection?.rangeCount ? selection.getRangeAt(0) : null;
}
function moveCaretOutsideStyles(range, properties) {
  if (!range?.collapsed) return false;
  let moved = false;
  while (true) {
    const container = range.startContainer;
    const ancestor = container.nodeType === Node.ELEMENT_NODE ? container : container.parentElement;
    let styledRun = ancestor;
    while (styledRun && styledRun !== editor) {
      const hasRequestedStyle = properties.some((property) => {
        // A marker's contrast ink is only there to keep its fill readable;
        // clearing text color must not split the text out of its highlight.
        if (property === 'color' && styledRun.tagName === 'MARK' && styledRun.style.backgroundColor) return false;
        const value = styledRun.style?.getPropertyValue(property)?.trim().toLowerCase() || '';
        if (property === 'background-color') return styledRun.tagName === 'MARK' || Boolean(value);
        if (property === 'color') return Boolean(value) || (styledRun.tagName === 'FONT' && styledRun.hasAttribute('color'));
        if (property === 'font-weight') {
          const weight = Number.parseInt(value, 10);
          return ['B', 'STRONG'].includes(styledRun.tagName) || value === 'bold' || (Number.isFinite(weight) && weight >= 600);
        }
        if (property === 'font-style') return ['I', 'EM'].includes(styledRun.tagName) || value === 'italic' || value === 'oblique';
        if (property === 'text-decoration') {
          const decoration = `${value} ${styledRun.style?.textDecorationLine || ''}`.toLowerCase();
          return styledRun.tagName === 'U' || /(?:^|\s)underline(?:\s|$)/.test(decoration);
        }
        return Boolean(value);
      });
      if (hasRequestedStyle) break;
      styledRun = styledRun.parentElement;
    }
    if (!styledRun || styledRun === editor) break;

    const tailRange = document.createRange();
    tailRange.selectNodeContents(styledRun);
    tailRange.setStart(range.startContainer, range.startOffset);
    tailRange.setEnd(styledRun, styledRun.childNodes.length);
    const tail = tailRange.extractContents();
    const parent = styledRun.parentNode;
    const rightRun = styledRun.cloneNode(false);
    rightRun.append(tail);
    if (rightRun.childNodes.length) parent.insertBefore(rightRun, styledRun.nextSibling);

    if (styledRun.childNodes.length) range.setStartAfter(styledRun);
    else {
      const index = [...parent.childNodes].indexOf(styledRun);
      styledRun.remove();
      range.setStart(parent, Math.max(0, index));
    }
    range.collapse(true);
    moved = true;
  }
  return moved;
}
function moveCaretOutsideHighlights(range) { return moveCaretOutsideStyles(range, ['background-color']); }
function removeInlinePropertyFromFragment(fragment, property) {
  for (const element of [...fragment.querySelectorAll('*')].reverse()) {
    if (property === 'background-color') {
      element.style?.removeProperty('background-color');
      if (element.tagName === 'MARK') {
        // This foreground was chosen for the old marker shade. Let the next
        // highlight choose fresh contrast when the selection is recolored.
        element.style.removeProperty('color');
        element.replaceWith(...element.childNodes);
        continue;
      }
    } else if (property === 'color') {
      element.style?.removeProperty('color');
      if (element.tagName === 'FONT') element.removeAttribute('color');
    }
    if (element.style && !element.style.length) element.removeAttribute('style');
    if (element.tagName === 'SPAN' && !element.attributes.length) element.replaceWith(...element.childNodes);
  }
}
function removeEmptyInlineWrappers(root) {
  for (const element of [...root.querySelectorAll('mark,span')].reverse()) {
    if (!element.textContent && !element.querySelector('br,img,figure')) element.remove();
  }
}
function splitInlineWrapperAroundText(wrapper, targetText) {
  function split(node) {
    if (node === targetText) return { before: null, selected: targetText, after: null };
    const children = [...node.childNodes];
    const index = children.findIndex((child) => child === targetText || child.contains?.(targetText));
    if (index < 0) return { before: null, selected: null, after: null };
    const nested = split(children[index]);
    const cloneWith = (nodes) => {
      if (!nodes.length) return null;
      const clone = node.cloneNode(false);
      nodes.forEach((child) => clone.append(child));
      return clone;
    };
    return {
      before: cloneWith([...children.slice(0, index), nested.before].filter(Boolean)),
      selected: cloneWith([nested.selected].filter(Boolean)),
      after: cloneWith([nested.after, ...children.slice(index + 1)].filter(Boolean)),
    };
  }
  const parts = split(wrapper);
  if (!parts.selected) return null;
  wrapper.replaceWith(...[parts.before, parts.selected, parts.after].filter(Boolean));
  return parts.selected;
}
function isInlineFormattingWrapper(element) {
  if (!element || element === editor) return false;
  if (['B', 'STRONG', 'I', 'EM', 'U', 'S', 'MARK', 'FONT'].includes(element.tagName)) return true;
  if (element.tagName !== 'SPAN') return false;
  if (/^h[1-4]$/.test(element.dataset.copadHeading || '')) return true;
  const style = element.style;
  return Boolean(style.color || style.backgroundColor || style.fontWeight || style.fontStyle
    || style.textDecoration || style.textDecorationLine || style.fontFamily);
}
function stripInheritedFormattingFromText(textNode) {
  let changed = false;
  while (textNode?.parentElement && textNode.parentElement !== editor) {
    let wrapper = textNode.parentElement;
    while (wrapper && wrapper !== editor && !isInlineFormattingWrapper(wrapper)) wrapper = wrapper.parentElement;
    if (!wrapper || wrapper === editor) break;
    const selectedWrapper = splitInlineWrapperAroundText(wrapper, textNode);
    if (!selectedWrapper) break;
    selectedWrapper.replaceWith(...selectedWrapper.childNodes);
    changed = true;
  }
  return changed;
}
function stripInheritedFormattingFromInsertion(start, length) {
  if (!Number.isFinite(start) || !Number.isFinite(length) || length < 1) return false;
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
  const segments = [];
  let textOffset = 0;
  let node;
  while ((node = walker.nextNode())) {
    const segmentStart = Math.max(0, start - textOffset);
    const segmentEnd = Math.min(node.length, start + length - textOffset);
    if (segmentEnd > segmentStart) segments.push({ node, start: segmentStart, end: segmentEnd });
    textOffset += node.length;
    if (textOffset >= start + length) break;
  }
  let changed = false;
  for (const segment of segments.reverse()) {
    const insertedText = segment.start ? segment.node.splitText(segment.start) : segment.node;
    if (segment.end - segment.start < insertedText.length) insertedText.splitText(segment.end - segment.start);
    changed = stripInheritedFormattingFromText(insertedText) || changed;
  }
  return changed;
}
function normalizeInsertedHeadingBlocks(start, length) {
  if (!Number.isFinite(start) || !Number.isFinite(length) || length < 1) return false;
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
  const blocks = new Set();
  let textOffset = 0;
  let node;
  while ((node = walker.nextNode())) {
    const segmentStart = Math.max(0, start - textOffset);
    const segmentEnd = Math.min(node.length, start + length - textOffset);
    if (segmentEnd > segmentStart) {
      let ancestor = node.parentElement;
      while (ancestor && ancestor !== editor) {
        if (/^H[1-4]$/.test(ancestor.tagName)) blocks.add(ancestor);
        ancestor = ancestor.parentElement;
      }
    }
    textOffset += node.length;
    if (textOffset >= start + length) break;
  }
  for (const heading of blocks) {
    const paragraph = document.createElement('p');
    while (heading.firstChild) paragraph.append(heading.firstChild);
    heading.replaceWith(paragraph);
  }
  return Boolean(blocks.size);
}
function wrapFragmentText(fragment, property, color, tagName) {
  const walker = document.createTreeWalker(fragment, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  let node;
  while ((node = walker.nextNode())) if (node.length) textNodes.push(node);
  let lastWrapper = null;
  for (const textNode of textNodes) {
    const wrapper = document.createElement(tagName);
    wrapper.style.setProperty(property, color);
    const hasExplicitTextColorParent = (() => {
      let parent = textNode.parentElement;
      while (parent) {
        if (parent.style?.color) return true;
        parent = parent.parentElement;
      }
      return false;
    })();
    if (property === 'background-color' && tagName === 'mark' && !hasExplicitTextColorParent) {
      const ink = readableHighlightInk(color);
      if (ink) wrapper.style.color = ink;
    }
    textNode.parentNode.insertBefore(wrapper, textNode);
    wrapper.append(textNode);
    lastWrapper = wrapper;
  }
  return lastWrapper;
}
function placeCaretAtTextOffset(textOffset) {
  const [node, offset] = textNodeAt(editor, textOffset);
  const caret = document.createRange();
  caret.setStart(node, offset);
  caret.collapse(true);
  const selection = getSelection();
  selection.removeAllRanges();
  selection.addRange(caret);
}
function placeTextSelection(startOffset, endOffset) {
  const [startNode, start] = textNodeAt(editor, startOffset);
  const [endNode, end] = textNodeAt(editor, endOffset);
  const range = document.createRange();
  range.setStart(startNode, start);
  range.setEnd(endNode, end);
  const selection = getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}
function hasHighlightAroundTextNode(textNode) {
  let ancestor = textNode.parentElement;
  while (ancestor && ancestor !== editor) {
    if (ancestor.tagName === 'MARK' || ancestor.style?.backgroundColor) return true;
    ancestor = ancestor.parentElement;
  }
  return false;
}
function removeHighlightFromTextNode(textNode) {
  let changed = false;
  let ancestor = textNode.parentElement;
  while (ancestor && ancestor !== editor) {
    const parent = ancestor.parentElement;
    if (ancestor.tagName === 'MARK' || ancestor.style?.backgroundColor) {
      const selectedWrapper = splitInlineWrapperAroundText(ancestor, textNode);
      if (selectedWrapper) {
        selectedWrapper.style?.removeProperty('background-color');
        if (selectedWrapper.tagName === 'MARK') selectedWrapper.style.removeProperty('color');
        if (selectedWrapper.style && !selectedWrapper.style.length) selectedWrapper.removeAttribute('style');
        if (!selectedWrapper.attributes.length) selectedWrapper.replaceWith(...selectedWrapper.childNodes);
        changed = true;
        ancestor = textNode.parentElement;
        continue;
      }
    }
    ancestor = parent;
  }
  return changed;
}
function hasExplicitTextColorAround(textNode) {
  let ancestor = textNode.parentElement;
  while (ancestor && ancestor !== editor) {
    if (ancestor.style?.color || (ancestor.tagName === 'FONT' && ancestor.hasAttribute('color'))) return true;
    ancestor = ancestor.parentElement;
  }
  return false;
}
function applyInlineColorToSelection(snapshot, property, color, tagName = 'span') {
  if (!/^#[\da-f]{6}$/i.test(color)) return false;
  editor.focus({ preventScroll: true });
  const range = selectionRange(snapshot);
  if (!range || range.collapsed || snapshot.start === snapshot.end) { showToast('Select text first'); return false; }
  undoManager?.stopCapturing();

  // Keep text-color spans inside their existing mark/span ancestors. Extracting
  // a subrange from a single highlighted text node returns only a bare Text
  // node; reinserting that fragment outside its ancestor loses the highlight.
  if (property === 'color') {
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    const segments = [];
    let textOffset = 0; let textNode;
    while ((textNode = walker.nextNode())) {
      const start = Math.max(0, snapshot.start - textOffset);
      const end = Math.min(textNode.length, snapshot.end - textOffset);
      if (end > start) segments.push({ node: textNode, start, end });
      textOffset += textNode.length;
      if (textOffset >= snapshot.end) break;
    }
    if (!segments.length) { showToast('Select text first'); return false; }
    for (const segment of segments.reverse()) {
      const selectedNode = segment.start ? segment.node.splitText(segment.start) : segment.node;
      const selectedLength = segment.end - segment.start;
      if (selectedLength < selectedNode.length) selectedNode.splitText(selectedLength);
      const wrapper = document.createElement(tagName);
      wrapper.style.setProperty(property, color);
      selectedNode.parentNode.insertBefore(wrapper, selectedNode);
      wrapper.append(selectedNode);
    }
    // The text itself is unchanged by formatting, so use the saved selection
    // end instead of the live Range. Browsers can invalidate that Range while
    // the selected text nodes are split and wrapped.
    placeCaretAtTextOffset(snapshot.end);
    savedSelection = null;
    markChanged();
    placeCaretAtTextOffset(snapshot.end);
    undoManager?.stopCapturing();
    updateLocalCursor();
    return true;
  }

  if (property === 'background-color') {
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    const segments = [];
    let textOffset = 0;
    let textNode;
    while ((textNode = walker.nextNode())) {
      const start = Math.max(0, snapshot.start - textOffset);
      const end = Math.min(textNode.length, snapshot.end - textOffset);
      if (end > start) segments.push({ node: textNode, start, end });
      textOffset += textNode.length;
      if (textOffset >= snapshot.end) break;
    }
    if (!segments.length) { showToast('Select text first'); return false; }

    // Split and replace highlight runs in place. Extracting a range fragment
    // can detach or flatten a selected heading span when highlight is applied
    // after the heading style.
    for (const segment of segments.reverse()) {
      const selectedNode = segment.start ? segment.node.splitText(segment.start) : segment.node;
      const selectedLength = segment.end - segment.start;
      if (selectedLength < selectedNode.length) selectedNode.splitText(selectedLength);
      removeHighlightFromTextNode(selectedNode);

      const mark = document.createElement('mark');
      mark.style.setProperty('background-color', color);
      if (!hasExplicitTextColorAround(selectedNode)) {
        const ink = readableHighlightInk(color);
        if (ink) mark.style.color = ink;
      }
      selectedNode.parentNode.insertBefore(mark, selectedNode);
      mark.append(selectedNode);
    }

    savedSelection = null;
    placeCaretAtTextOffset(snapshot.end);
    markChanged();
    placeCaretAtTextOffset(snapshot.end);
    undoManager?.stopCapturing();
    updateLocalCursor();
    return true;
  }

  const selected = range.extractContents();
  removeEmptyInlineWrappers(editor);
  removeInlinePropertyFromFragment(selected, property);
  const finalWrapper = wrapFragmentText(selected, property, color, tagName);
  if (!finalWrapper) { showToast('Select text first'); return false; }
  // Extracting text from inside an existing <mark> leaves the collapsed
  // insertion range inside that old mark when both selection edges share one
  // text node. Split the old run before reinserting so colors replace rather
  // than nest/stack, while unselected text keeps its original mark.
  if (property === 'background-color') moveCaretOutsideHighlights(range);
  range.insertNode(selected);
  // Preserve the logical end of the original selection across fragment
  // insertion and sanitizing; the live Range may otherwise collapse to zero.
  placeCaretAtTextOffset(snapshot.end);
  savedSelection = null;
  markChanged();
  placeCaretAtTextOffset(snapshot.end);
  undoManager?.stopCapturing();
  updateLocalCursor();
  return true;
}
function applySelectedInlineCommand(command, value = null, snapshot = savedSelection || captureSelection()) {
  const range = selectionRange(snapshot);
  if (!range || range.collapsed) { showToast('Select text first'); return; }
  undoManager?.stopCapturing();
  editor.focus(); document.execCommand(command, false, value); markChanged(); undoManager?.stopCapturing(); updateLocalCursor();
}
function applyInlineHeadingToSelection(blockName, snapshot = savedSelection || captureSelection()) {
  const level = String(blockName).toLowerCase();
  const range = selectionRange(snapshot);
  if ((!/^h[1-4]$/.test(level) && level !== 'clear') || !range || range.collapsed || !snapshot || snapshot.start >= snapshot.end) {
    showToast('Select text first');
    return;
  }
  editor.focus({ preventScroll: true });
  undoManager?.stopCapturing();
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
  const segments = [];
  let textOffset = 0;
  let textNode;
  while ((textNode = walker.nextNode())) {
    const start = Math.max(0, snapshot.start - textOffset);
    const end = Math.min(textNode.length, snapshot.end - textOffset);
    if (end > start) segments.push({ node: textNode, start, end });
    textOffset += textNode.length;
    if (textOffset >= snapshot.end) break;
  }
  if (!segments.length) { showToast('Select text first'); return; }

  // Older versions made whole blocks headings. Normalize touched legacy
  // blocks before applying or clearing a selected-text heading style.
  const legacyBlocks = new Set();
  for (const { node } of segments) {
    let ancestor = node.parentElement;
    while (ancestor && ancestor !== editor) {
      if (/^H[1-4]$/.test(ancestor.tagName)) legacyBlocks.add(ancestor);
      ancestor = ancestor.parentElement;
    }
  }
  for (const heading of legacyBlocks) {
    const paragraph = document.createElement('p');
    while (heading.firstChild) paragraph.append(heading.firstChild);
    heading.replaceWith(paragraph);
  }
  let changed = legacyBlocks.size > 0;

  for (const segment of segments.reverse()) {
    const selectedNode = segment.start ? segment.node.splitText(segment.start) : segment.node;
    const selectedLength = segment.end - segment.start;
    if (selectedLength < selectedNode.length) selectedNode.splitText(selectedLength);

    let ancestor = selectedNode.parentElement;
    while (ancestor && ancestor !== editor) {
      const parent = ancestor.parentElement;
      if (ancestor.tagName === 'SPAN' && /^h[1-4]$/.test(ancestor.dataset.copadHeading || '')) {
        const selectedHeading = splitInlineWrapperAroundText(ancestor, selectedNode);
        if (!selectedHeading) { ancestor = parent; continue; }
        selectedHeading.removeAttribute('data-copad-heading');
        changed = true;
        if (!selectedHeading.attributes.length) selectedHeading.replaceWith(...selectedHeading.childNodes);
        ancestor = selectedNode.parentElement;
      } else ancestor = parent;
    }

    if (level !== 'clear') {
      // Keep highlighted text in one stable nesting order regardless of which
      // style the user applies first: heading > highlight > selected text.
      let highlightedWrapper = null;
      let ancestor = selectedNode.parentElement;
      while (ancestor && ancestor !== editor) {
        if (ancestor.tagName === 'MARK') highlightedWrapper = ancestor;
        ancestor = ancestor.parentElement;
      }
      const headingContent = highlightedWrapper
        ? (splitInlineWrapperAroundText(highlightedWrapper, selectedNode) || selectedNode)
        : selectedNode;
      const headingText = document.createElement('span');
      headingText.dataset.copadHeading = level;
      headingContent.parentNode.insertBefore(headingText, headingContent);
      headingText.append(headingContent);
      changed = true;
    }
  }
  if (!changed) {
    savedSelection = null;
    placeTextSelection(snapshot.start, snapshot.end);
    undoManager?.stopCapturing();
    return;
  }
  savedSelection = null;
  placeTextSelection(snapshot.start, snapshot.end);
  markChanged();
  placeTextSelection(snapshot.start, snapshot.end);
  undoManager?.stopCapturing();
  updateLocalCursor();
}
function applySelectedBlock(blockName, snapshot = savedSelection || captureSelection()) {
  if (/^h[1-4]$/i.test(String(blockName)) || String(blockName).toLowerCase() === 'clear-heading') {
    const requested = String(blockName).toLowerCase() === 'clear-heading' ? 'clear' : blockName;
    applyInlineHeadingToSelection(requested, snapshot);
    return;
  }
  const range = selectionRange(snapshot);
  if (!range) { showToast('Place the caret in a paragraph first'); return; }
  undoManager?.stopCapturing();
  editor.focus(); document.execCommand('formatBlock', false, `<${blockName.toUpperCase()}>`); markChanged(); undoManager?.stopCapturing(); updateLocalCursor();
}
function chooseTextColor(color, snapshot = savedSelection || captureSelection()) { applyInlineColorToSelection(snapshot, 'color', color); colorPopover.classList.add('hidden'); }
function setHighlightColor(color, snapshot = savedSelection || captureSelection()) {
  if (!/^#[\da-f]{6}$/i.test(color)) return;
  selectedHighlightColor = color; localStorage.setItem('copad-highlight-color', color);
  updateMarkerToolAppearance();
  markerCursor?.style.setProperty('--selected-highlight', color);
  applyInlineColorToSelection(snapshot, 'background-color', color, 'mark'); highlightPopover.classList.add('hidden');
}
function hasInlineTextColor(element) {
  return Boolean(element?.style?.getPropertyValue('color')
    || (element?.tagName === 'FONT' && element.hasAttribute('color')));
}
function splitWrapperAroundText(wrapper, targetText) {
  function split(node) {
    if (node === targetText) return { before: null, selected: targetText, after: null };
    const children = [...node.childNodes];
    const index = children.findIndex((child) => child === targetText || child.contains?.(targetText));
    if (index < 0) return { before: null, selected: null, after: null };
    const nested = split(children[index]);
    const cloneWith = (nodes) => {
      if (!nodes.length) return null;
      const clone = node.cloneNode(false);
      nodes.forEach((child) => clone.append(child));
      return clone;
    };
    return {
      before: cloneWith([...children.slice(0, index), nested.before].filter(Boolean)),
      selected: cloneWith([nested.selected].filter(Boolean)),
      after: cloneWith([nested.after, ...children.slice(index + 1)].filter(Boolean)),
    };
  }
  const parts = split(wrapper);
  if (!parts.selected) return null;
  wrapper.replaceWith(...[parts.before, parts.selected, parts.after].filter(Boolean));
  const branch = [parts.selected, ...parts.selected.querySelectorAll('*')].reverse();
  for (const element of branch) {
    element.style?.removeProperty('color');
    if (element.tagName === 'FONT') element.removeAttribute('color');
    if (element.style && !element.style.length) element.removeAttribute('style');
  }
  return targetText;
}
function clearTextColorInSelection(snapshot) {
  // A color-only operation must be text-neutral. Keep a recovery snapshot so a
  // malformed/imported wrapper can never turn a formatting click into typing.
  const originalHTML = editor.innerHTML;
  const originalText = editor.textContent;
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
  const segments = [];
  let textOffset = 0; let textNode;
  while ((textNode = walker.nextNode())) {
    const start = Math.max(0, snapshot.start - textOffset);
    const end = Math.min(textNode.length, snapshot.end - textOffset);
    if (end > start) segments.push({ node: textNode, start, end });
    textOffset += textNode.length;
    if (textOffset >= snapshot.end) break;
  }
  if (!segments.length) return false;
  const hasColorToRemove = segments.some(({ node }) => {
    let ancestor = node.parentElement;
    while (ancestor && ancestor !== editor) {
      if (hasInlineTextColor(ancestor)
        && !(ancestor.tagName === 'MARK' && ancestor.style.backgroundColor)) return true;
      ancestor = ancestor.parentElement;
    }
    return false;
  });
  if (!hasColorToRemove) return false;
  let lastSelectedText = null;
  let changed = false;
  for (const segment of [...segments].reverse()) {
    const selectedText = segment.start ? segment.node.splitText(segment.start) : segment.node;
    if (segment.end - segment.start < selectedText.length) selectedText.splitText(segment.end - segment.start);
    if (segment === segments.at(-1)) lastSelectedText = selectedText;

    let ancestor = selectedText.parentElement;
    while (ancestor && ancestor !== editor) {
      const isAutomaticHighlightInk = ancestor.tagName === 'MARK' && ancestor.style.backgroundColor;
      if (hasInlineTextColor(ancestor) && !isAutomaticHighlightInk) {
        const uncoloredText = splitWrapperAroundText(ancestor, selectedText);
        if (!uncoloredText) break;
        lastSelectedText = selectedText === lastSelectedText ? uncoloredText : lastSelectedText;
        changed = true;
        ancestor = uncoloredText.parentElement;
      } else ancestor = ancestor.parentElement;
    }
  }
  if (!changed || !lastSelectedText?.isConnected) {
    restoreSelection(snapshot);
    return false;
  }
  if (editor.textContent !== originalText) {
    editor.innerHTML = originalHTML;
    restoreSelection(snapshot);
    showToast('Text color could not be cleared safely. Your text was kept unchanged.');
    return false;
  }
  removeEmptyInlineWrappers(editor);
  const caret = document.createRange();
  caret.setStart(lastSelectedText, lastSelectedText.length);
  caret.collapse(true);
  const selection = getSelection(); selection.removeAllRanges(); selection.addRange(caret);
  return true;
}
function clearSelectedStyle(style, snapshot = savedSelection || captureSelection()) {
  const range = selectionRange(snapshot); if (!range || range.collapsed) { showToast('Select text first'); return; }
  undoManager?.stopCapturing();
  if (style === 'color') {
    if (!clearTextColorInSelection(snapshot)) { savedSelection = null; return; }
    const caretSnapshot = captureSelection();
    savedSelection = null;
    markChanged();
    // Sanitizing/syncing can rebuild styled nodes. Restore by logical text
    // offset afterward so the native caret never falls back to document start.
    if (caretSnapshot) restoreSelection(caretSnapshot);
    undoManager?.stopCapturing();
    updateLocalCursor();
    return;
  }
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
  const segments = [];
  let textOffset = 0;
  let textNode;
  while ((textNode = walker.nextNode())) {
    const start = Math.max(0, snapshot.start - textOffset);
    const end = Math.min(textNode.length, snapshot.end - textOffset);
    if (end > start) segments.push({ node: textNode, start, end });
    textOffset += textNode.length;
    if (textOffset >= snapshot.end) break;
  }
  let changed = false;
  for (const segment of segments.reverse()) {
    if (!hasHighlightAroundTextNode(segment.node)) continue;
    const selectedNode = segment.start ? segment.node.splitText(segment.start) : segment.node;
    const selectedLength = segment.end - segment.start;
    if (selectedLength < selectedNode.length) selectedNode.splitText(selectedLength);
    changed = removeHighlightFromTextNode(selectedNode) || changed;
  }
  savedSelection = null;
  if (!changed) {
    placeTextSelection(snapshot.start, snapshot.end);
    undoManager?.stopCapturing();
    return;
  }
  placeCaretAtTextOffset(snapshot.end);
  markChanged();
  placeCaretAtTextOffset(snapshot.end);
  undoManager?.stopCapturing();
  updateLocalCursor();
}
const colorPopover = $('#color-popover');
const highlightPopover = $('#highlight-popover');
const fontPopover = $('#font-popover');
const selectionMenu = $('#selection-menu');
function updateMarkerToolAppearance() {
  const button = $('#marker-tool-button'); button.setAttribute('aria-pressed', String(markerMode));
  button.style.setProperty('--selected-highlight', selectedHighlightColor);
  editor.style.setProperty('--selected-highlight', selectedHighlightColor);
  editor.classList.toggle('marker-mode', markerMode);
  button.title = markerMode ? 'Highlight pen on — drag across text to mark (click to turn off)' : 'Turn on highlight pen';
  button.setAttribute('aria-label', button.title);
}
editor.addEventListener('beforeinput', (event) => {
  hideSystemPointerForTyping();
  pendingInlineInsertion = null;
  pendingEmptyEditorReset = false;
  if (documentRenderPending) applyPendingRemoteEditorUpdate();
  handleHistoryBeforeInput(event);
  if (event.defaultPrevented) return;
  pendingEmptyEditorReset = event.inputType?.startsWith('delete') || false;
  if (event.inputType?.startsWith('insert')) {
    const selection = getSelection();
    if (!event.isComposing && ['insertText', 'insertReplacementText', 'insertFromComposition'].includes(event.inputType)
      && typeof event.data === 'string' && event.data.length
      && selection?.rangeCount && editor.contains(selection.anchorNode)) {
      const range = selection.getRangeAt(0);
      pendingInlineInsertion = {
        start: textOffsetAtPoint(editor, range.startContainer, range.startOffset),
        length: event.data.length,
      };
    }
    if (selection?.isCollapsed && editor.contains(selection.anchorNode)) {
      const insertionPoint = selection.getRangeAt(0).cloneRange();
      if (moveCaretOutsideStyles(insertionPoint, ['background-color', 'color', 'font-weight', 'font-style', 'text-decoration'])) {
        selection.removeAllRanges();
        selection.addRange(insertionPoint);
      }
    }
  }
  if (shouldPlayKeySound(event)) playTypeSound();
});
titleInput.addEventListener('beforeinput', (event) => {
  hideSystemPointerForTyping();
  handleHistoryBeforeInput(event);
  if (shouldPlayKeySound(event)) playTypeSound();
});
editor.addEventListener('input', () => {
  const insertion = pendingInlineInsertion;
  const resetEmptyEditor = pendingEmptyEditorReset;
  pendingInlineInsertion = null;
  pendingEmptyEditorReset = false;
  if (insertion) {
    const stripped = stripInheritedFormattingFromInsertion(insertion.start, insertion.length);
    const normalizedBlock = normalizeInsertedHeadingBlocks(insertion.start, insertion.length);
    if (stripped || normalizedBlock) placeCaretAtTextOffset(insertion.start + insertion.length);
  }
  if (resetEmptyEditor) resetEmptyEditorToPlain();
  if (resetColorOnNextInput) resetColorOnNextInput = false;
  markChanged(); updateStats(); updateEditorPlaceholder(); updateLocalCursor();
});
editor.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.isComposing) requestAnimationFrame(updateLocalCursor);
});
editor.addEventListener('keyup', updateLocalCursor);
editor.addEventListener('mouseup', updateLocalCursor);
editor.addEventListener('dblclick', () => {
  requestAnimationFrame(() => {
    const selection = getSelection();
    if (!selection?.rangeCount || selection.isCollapsed
      || !editor.contains(selection.anchorNode) || !editor.contains(selection.focusNode)) return;
    const range = selection.getRangeAt(0).cloneRange();
    const trailingSpace = range.toString().match(/[ \t\u00a0]+$/u)?.[0];
    if (!trailingSpace) return;
    const end = textOffsetAtPoint(editor, range.endContainer, range.endOffset) - trailingSpace.length;
    const start = textOffsetAtPoint(editor, range.startContainer, range.startOffset);
    if (end <= start) return;
    const [endNode, endOffset] = textNodeAt(editor, end);
    range.setEnd(endNode, endOffset);
    selection.removeAllRanges();
    selection.addRange(range);
  });
});
editor.addEventListener('focus', () => {
  undoManager?.stopCapturing();
  if (!editor.textContent.trim() && !editor.querySelector('img,figure') && !editor.querySelector('p,div,h1,h2,h3,h4,blockquote,ul,ol')) {
    const paragraph = document.createElement('p');
    paragraph.append(document.createElement('br'));
    editor.replaceChildren(paragraph);
    const range = document.createRange();
    range.setStart(paragraph, 0);
    range.collapse(true);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    markChanged();
  }
  updateLocalCursor();
});
editor.addEventListener('blur', () => { undoManager?.stopCapturing(); if (provider) provider.awareness.setLocalStateField('cursor', null); if (localCursorMarker) localCursorMarker.classList.add('hidden'); });
document.addEventListener('selectionchange', () => { if (document.activeElement === editor) updateLocalCursor(); });
titleInput.addEventListener('compositionstart', () => { titleIsComposing = true; });
titleInput.addEventListener('compositionend', () => { titleIsComposing = false; titleInput.dispatchEvent(new Event('input', { bubbles: true })); });
titleInput.addEventListener('focus', () => undoManager?.stopCapturing());
titleInput.addEventListener('blur', () => undoManager?.stopCapturing());
titleInput.addEventListener('input', () => {
  if (sharedTitle && !applyingRemote) replaceSharedText(sharedTitle, titleInput.value, editorOrigin);
  storeRoomSnapshotLocally(editor.innerHTML, titleInput.value); $('#detail-edited').textContent = 'Just now';
});
for (const button of document.querySelectorAll('[data-command]')) {
  button.addEventListener('mousedown', (event) => { savedSelection = captureSelection(); event.preventDefault(); });
  button.addEventListener('click', () => {
    const command = button.dataset.command;
    if (command === 'undo' || command === 'redo') { performRoomHistoryAction(command); return; }
    if (command === 'bold' || command === 'italic' || command === 'underline') applySelectedInlineCommand(command);
    else if (command === 'insertUnorderedList') { undoManager?.stopCapturing(); editor.focus(); document.execCommand(command); markChanged(); undoManager?.stopCapturing(); }
  });
}
for (const button of document.querySelectorAll('[data-block]')) {
  button.addEventListener('mousedown', (event) => { savedSelection = captureSelection(); event.preventDefault(); });
  button.addEventListener('click', () => applySelectedBlock(button.dataset.block));
}
const imageFileInput = $('#image-file-input');
$('#insert-image').addEventListener('mousedown', (event) => { savedSelection = captureSelection(); event.preventDefault(); });
$('#insert-image').addEventListener('click', () => { savedSelection = captureSelection() || savedSelection; imageFileInput.click(); });
imageFileInput.addEventListener('change', () => { const file = imageFileInput.files?.[0]; if (file) insertImageFile(file, savedSelection || captureSelection()); imageFileInput.value = ''; });
editor.addEventListener('paste', (event) => {
  const item = [...(event.clipboardData?.items || [])].find((candidate) => candidate.type.startsWith('image/'));
  const file = item?.getAsFile() || [...(event.clipboardData?.files || [])].find((candidate) => candidate.type.startsWith('image/'));
  if (file) { event.preventDefault(); insertImageFile(file, captureSelection()); return; }

  const clipboard = event.clipboardData;
  if (!clipboard) return;
  event.preventDefault();
  const safeHtml = clipboard.getData('text/html') ? sanitizeHTML(clipboard.getData('text/html')) : '';
  const plainText = clipboard.getData('text/plain');
  const pasteHtml = safeHtml || plainText.split(/\r\n?|\n/).map((line) => `<p>${line ? escapeHtml(line) : '<br>'}</p>`).join('');
  if (!pasteHtml) return;
  undoManager?.stopCapturing();
  editor.focus();
  document.execCommand('insertHTML', false, pasteHtml);
  const pastedCaret = captureSelection();
  markChanged();
  undoManager?.stopCapturing();
  if (pastedCaret) restoreSelection(pastedCaret);
  updateStats(); updateEditorPlaceholder(); updateLocalCursor();
  requestAnimationFrame(scrollCaretIntoPaper);
});
$('#color-button').addEventListener('mousedown', (event) => { savedSelection = captureSelection(); event.preventDefault(); });
$('#color-button').addEventListener('click', () => colorPopover.classList.toggle('hidden'));
$('#highlight-button').addEventListener('mousedown', (event) => { savedSelection = captureSelection(); event.preventDefault(); });
$('#highlight-button').addEventListener('click', () => highlightPopover.classList.toggle('hidden'));
$('#marker-tool-button').addEventListener('mousedown', (event) => event.preventDefault());
$('#marker-tool-button').addEventListener('click', () => { markerMode = !markerMode; updateMarkerToolAppearance(); });
const markerCursor = document.createElement('span');
markerCursor.className = 'marker-cursor';
markerCursor.setAttribute('aria-hidden', 'true');
markerCursor.innerHTML = '<svg viewBox="0 0 28 28"><path class="marker-cursor-fill" d="m5 17 11-11 5 5-11 11H5v-5Z"/><path d="m14 8 5 5M5 22l-2 3m2-8 3 3m8-14 2-2 5 5-2 2"/></svg>';
document.body.append(markerCursor);
markerCursor.style.setProperty('--selected-highlight', selectedHighlightColor);
function hideMarkerCursor() { markerCursor.classList.remove('visible'); }
document.addEventListener('pointermove', (event) => {
  if (!markerMode || !editor.contains(event.target)) { hideMarkerCursor(); return; }
  markerCursor.style.left = `${event.clientX - 3}px`;
  markerCursor.style.top = `${event.clientY - 22}px`;
  markerCursor.classList.add('visible');
}, true);
editor.addEventListener('pointerdown', (event) => {
  markerStrokeStart = markerMode && event.button === 0
    ? { x: event.clientX, y: event.clientY, pointerId: event.pointerId }
    : null;
});
editor.addEventListener('pointerup', (event) => {
  const start = markerStrokeStart;
  markerStrokeStart = null;
  if (!markerMode || event.button !== 0 || !start || start.pointerId !== event.pointerId || Math.hypot(event.clientX - start.x, event.clientY - start.y) < 3) return;
  const stroke = captureSelection();
  if (!stroke || stroke.start === stroke.end) return;
  applyInlineColorToSelection(stroke, 'background-color', selectedHighlightColor, 'mark');
});
editor.addEventListener('pointercancel', () => { markerStrokeStart = null; });
updateMarkerToolAppearance();
$('#font-select').addEventListener('mousedown', (event) => { savedSelection = captureSelection(); event.preventDefault(); });
$('#font-select').addEventListener('click', () => fontPopover.classList.toggle('hidden'));
function preservePaletteSelection(event) {
  // The browser retains the actual text selection because these controls
  // prevent focus. Refresh its snapshot on every palette click so an old
  // range can never be reused after the user selected different text.
  const current = captureSelection();
  if (current && current.start !== current.end) savedSelection = current;
  else if (!savedSelection && current) savedSelection = current;
  event.preventDefault();
}
document.querySelectorAll('#color-popover [data-color]').forEach((button) => {
  button.addEventListener('mousedown', preservePaletteSelection);
  button.addEventListener('click', () => chooseTextColor(button.dataset.color));
});
document.querySelectorAll('#highlight-popover [data-highlight]').forEach((button) => {
  button.addEventListener('mousedown', preservePaletteSelection);
  button.addEventListener('click', () => setHighlightColor(button.dataset.highlight));
});
document.querySelectorAll('[data-clear-style]').forEach((button) => {
  button.addEventListener('mousedown', preservePaletteSelection);
  button.addEventListener('click', () => {
    clearSelectedStyle(button.dataset.clearStyle, savedSelection || captureSelection());
    (button.dataset.clearStyle === 'color' ? colorPopover : highlightPopover).classList.add('hidden');
  });
});
const pickerSelections = new WeakMap();
for (const [pickerId, action] of [['color-picker', chooseTextColor], ['highlight-picker', setHighlightColor]]) {
  const picker = $(`#${pickerId}`);
  picker.addEventListener('mousedown', () => { pickerSelections.set(picker, captureSelection() || savedSelection); });
  picker.addEventListener('change', () => { action(picker.value, pickerSelections.get(picker)); pickerSelections.delete(picker); });
}
document.querySelectorAll('[data-font]').forEach((button) => button.addEventListener('click', () => {
  applySelectedInlineCommand('fontName', button.dataset.font); fontPopover.classList.add('hidden');
  $('#font-select').querySelector('span:nth-child(2)').textContent = button.textContent;
}));
document.querySelectorAll('#selection-menu [data-menu-command]').forEach((button) => button.addEventListener('click', () => applySelectedInlineCommand(button.dataset.menuCommand, null, savedSelection)));
document.querySelectorAll('#selection-menu [data-menu-block]').forEach((button) => button.addEventListener('click', () => applySelectedBlock(button.dataset.menuBlock, savedSelection)));
document.querySelectorAll('#selection-menu [data-menu-color]').forEach((button) => button.addEventListener('click', () => chooseTextColor(button.dataset.menuColor, savedSelection)));
document.querySelectorAll('#selection-menu [data-menu-highlight]').forEach((button) => button.addEventListener('click', () => setHighlightColor(button.dataset.menuHighlight, savedSelection)));
document.querySelectorAll('#selection-menu [data-menu-clear]').forEach((button) => button.addEventListener('click', () => clearSelectedStyle(button.dataset.menuClear, savedSelection)));
selectionMenu.addEventListener('click', (event) => {
  if (event.target.closest('button')) selectionMenu.classList.add('hidden');
});
let contextSelection = null;
for (const [pickerId, action] of [['context-color-picker', chooseTextColor], ['context-highlight-picker', setHighlightColor]]) {
  const picker = $(`#${pickerId}`);
  picker.addEventListener('mousedown', () => { pickerSelections.set(picker, savedSelection || contextSelection || captureSelection()); });
  picker.addEventListener('change', () => {
    action(picker.value, pickerSelections.get(picker));
    pickerSelections.delete(picker);
    selectionMenu.classList.add('hidden');
  });
}
document.querySelectorAll('#selection-menu button').forEach((button) => button.addEventListener('mousedown', (event) => { savedSelection ||= contextSelection; event.preventDefault(); }));
function placeSelectionMenu(event) {
  selectionMenu.classList.remove('hidden');
  const bounds = selectionMenu.getBoundingClientRect(); const edge = 12;
  selectionMenu.style.left = `${Math.max(edge, Math.min(event.clientX, window.innerWidth - bounds.width - edge))}px`;
  selectionMenu.style.top = `${Math.max(edge, Math.min(event.clientY, window.innerHeight - bounds.height - edge))}px`;
}
editor.addEventListener('contextmenu', (event) => {
  const selection = captureSelection();
  if (!selection || selection.start === selection.end) return;
  event.preventDefault(); contextSelection = savedSelection = selection; placeSelectionMenu(event);
});
document.addEventListener('click', (event) => {
  if (!event.target.closest('.format-bar')) { colorPopover.classList.add('hidden'); highlightPopover.classList.add('hidden'); fontPopover.classList.add('hidden'); }
  if (!event.target.closest('#selection-menu')) selectionMenu.classList.add('hidden');
});

let draggedImage = null;
function rowForImage(figure) { return figure.parentElement?.matches('[data-copad-image-row="true"]') ? figure.parentElement : null; }
function resizeImageRow(row) {
  const figures = [...row.querySelectorAll(':scope > figure[data-copad-image="true"]')];
  figures.forEach((figure) => { figure.style.width = `${100 / figures.length}%`; });
}
function removeImageFromRow(figure) {
  const row = rowForImage(figure); if (!row) return;
  figure.remove();
  const remaining = [...row.querySelectorAll(':scope > figure[data-copad-image="true"]')];
  if (remaining.length === 1) { remaining[0].style.removeProperty('width'); row.replaceWith(remaining[0]); }
  else if (!remaining.length) row.remove();
  else resizeImageRow(row);
}
function placeImageBeside(source, target, pointerX) {
  if (!source?.isConnected || !target?.isConnected || source === target) return false;
  let row = rowForImage(target);
  if (row && rowForImage(source) === row) {
    const targetRect = target.getBoundingClientRect();
    row.insertBefore(source, pointerX < targetRect.left + targetRect.width / 2 ? target : target.nextSibling);
    resizeImageRow(row);
    return true;
  }
  if (rowForImage(source)) removeImageFromRow(source);
  if (!row) { row = document.createElement('div'); row.dataset.copadImageRow = 'true'; target.before(row); row.append(target); }
  const currentImages = [...row.querySelectorAll(':scope > figure[data-copad-image="true"]')];
  if (currentImages.length >= 3) {
    let nextRow = row.nextElementSibling?.matches('[data-copad-image-row="true"]') ? row.nextElementSibling : null;
    if (nextRow && nextRow.querySelectorAll(':scope > figure[data-copad-image="true"]').length >= 3) nextRow = null;
    if (!nextRow) { nextRow = document.createElement('div'); nextRow.dataset.copadImageRow = 'true'; row.after(nextRow); }
    nextRow.append(source);
    resizeImageRow(nextRow);
    return true;
  }
  const targetRect = target.getBoundingClientRect();
  row.insertBefore(source, pointerX < targetRect.left + targetRect.width / 2 ? target : target.nextSibling);
  resizeImageRow(row);
  return true;
}
editor.addEventListener('dragstart', (event) => {
  const figure = event.target.closest?.('figure[data-copad-image="true"]');
  if (!figure) return;
  undoManager?.stopCapturing();
  draggedImage = figure;
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', 'copad-image');
});
editor.addEventListener('dragover', (event) => {
  if (draggedImage && event.target.closest?.('figure[data-copad-image="true"]')) {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }
});
editor.addEventListener('drop', (event) => {
  const target = event.target.closest?.('figure[data-copad-image="true"]');
  if (!draggedImage || !target || draggedImage === target) return;
  event.preventDefault();
  if (placeImageBeside(draggedImage, target, event.clientX)) {
    activeImageFigure = draggedImage;
    markChanged();
    undoManager?.stopCapturing();
    positionImageResizeHandle();
  }
});
editor.addEventListener('dragend', () => { draggedImage = null; });
const imagePaper = $('#paper');
const imageResizeHandle = document.createElement('button');
imageResizeHandle.type = 'button';
imageResizeHandle.className = 'image-resize-handle hidden';
imageResizeHandle.setAttribute('aria-label', 'Resize selected image');
imageResizeHandle.title = 'Drag to resize image';
imageResizeHandle.textContent = '⤢';
const imageDeleteHandle = document.createElement('button');
imageDeleteHandle.type = 'button';
imageDeleteHandle.className = 'image-delete-handle hidden';
imageDeleteHandle.setAttribute('aria-label', 'Delete selected image');
imageDeleteHandle.title = 'Delete image';
imageDeleteHandle.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M3.5 5.25h9l-.65 8.1a1 1 0 0 1-1 .9h-5.7a1 1 0 0 1-1-.9l-.65-8.1Z"/><path d="M2.5 3.5h11M6 3.5V2.25h4V3.5M6.5 7v4.5M9.5 7v4.5"/></svg>';
imagePaper.append(imageResizeHandle, imageDeleteHandle);
let activeImageFigure = null;
let imageResizeDrag = null;
function positionImageResizeHandle() {
  if (!activeImageFigure?.isConnected) {
    imageResizeHandle.classList.add('hidden');
    imageDeleteHandle.classList.add('hidden');
    return;
  }
  const imageRect = activeImageFigure.getBoundingClientRect();
  const paperRect = imagePaper.getBoundingClientRect();
  imageResizeHandle.style.left = `${Math.round(imageRect.right - paperRect.left + imagePaper.scrollLeft - 12)}px`;
  imageResizeHandle.style.top = `${Math.round(imageRect.bottom - paperRect.top + imagePaper.scrollTop - 12)}px`;
  imageDeleteHandle.style.left = `${Math.round(imageRect.right - paperRect.left + imagePaper.scrollLeft - 12)}px`;
  imageDeleteHandle.style.top = `${Math.round(imageRect.top - paperRect.top + imagePaper.scrollTop - 12)}px`;
  imageResizeHandle.classList.remove('hidden');
  imageDeleteHandle.classList.remove('hidden');
}
editor.addEventListener('click', (event) => {
  const figure = event.target.closest?.('figure[data-copad-image="true"]');
  activeImageFigure = figure || null;
  positionImageResizeHandle();
});
imageResizeHandle.addEventListener('pointerdown', (event) => {
  if (!activeImageFigure?.isConnected || event.button !== 0) return;
  event.preventDefault();
  undoManager?.stopCapturing();
  const parent = activeImageFigure.parentElement;
  imageResizeDrag = {
    figure: activeImageFigure,
    pointerId: event.pointerId,
    startX: event.clientX,
    startWidth: activeImageFigure.getBoundingClientRect().width,
    parentWidth: parent.getBoundingClientRect().width,
    inRow: rowForImage(activeImageFigure) !== null,
  };
  imageResizeHandle.setPointerCapture(event.pointerId);
});
imageDeleteHandle.addEventListener('pointerdown', (event) => {
  // Keep the editor selection/caret stable while the image action is clicked.
  event.preventDefault();
  event.stopPropagation();
});
imageDeleteHandle.addEventListener('click', (event) => {
  event.preventDefault();
  event.stopPropagation();
  const figure = activeImageFigure;
  if (!figure?.isConnected) return;
  undoManager?.stopCapturing();
  if (rowForImage(figure)) removeImageFromRow(figure);
  else figure.remove();
  activeImageFigure = null;
  imageResizeDrag = null;
  positionImageResizeHandle();
  markChanged();
  undoManager?.stopCapturing();
});
document.addEventListener('pointermove', (event) => {
  if (!imageResizeDrag || event.pointerId !== imageResizeDrag.pointerId) return;
  const drag = imageResizeDrag;
  if (!drag.figure.isConnected) { imageResizeDrag = null; positionImageResizeHandle(); return; }
  const row = rowForImage(drag.figure);
  const rowImages = row ? [...row.querySelectorAll(':scope > figure[data-copad-image="true"]')] : [];
  const minOtherWidth = rowImages.length > 1 ? 120 * (rowImages.length - 1) : 0;
  const maxWidth = Math.max(120, drag.parentWidth - minOtherWidth);
  const nextWidth = Math.max(Math.min(120, maxWidth), Math.min(maxWidth, drag.startWidth + event.clientX - drag.startX));
  if (drag.inRow) {
    const nextPercent = Math.min(100, nextWidth / drag.parentWidth * 100);
    drag.figure.style.width = `${nextPercent}%`;
    rowImages.filter((figure) => figure !== drag.figure).forEach((figure) => { figure.style.width = `${(100 - nextPercent) / (rowImages.length - 1)}%`; });
  } else drag.figure.style.width = `${nextWidth}px`;
  positionImageResizeHandle();
});
document.addEventListener('pointerup', (event) => {
  if (!imageResizeDrag || event.pointerId !== imageResizeDrag.pointerId) return;
  imageResizeDrag = null;
  markChanged();
  undoManager?.stopCapturing();
  positionImageResizeHandle();
});
document.addEventListener('pointercancel', (event) => {
  if (imageResizeDrag?.pointerId === event.pointerId) imageResizeDrag = null;
});
imagePaper.addEventListener('scroll', positionImageResizeHandle, { passive: true });
window.addEventListener('resize', positionImageResizeHandle);
function roomUrl() {
  if (!hasRoom) return null;
  return `${location.origin}${location.pathname}?room=${encodeURIComponent(room)}`;
}
function openShare() {
  const url = roomUrl();
  $('#share-url-text').textContent = url || 'Run start.bat to open your HTTPS invite link';
  $('#copy-link').disabled = !url;
  $('#share-hint').textContent = url ? "They’ll choose a name when they arrive." : 'Double-click start.bat first, then share the HTTPS room link.';
  $('#share-modal').classList.remove('hidden');
}
$('#share-button').addEventListener('click', openShare);
$('#invite-link').addEventListener('click', openShare);
$('#close-share').addEventListener('click', () => $('#share-modal').classList.add('hidden'));
$('#share-modal').addEventListener('click', (event) => { if (event.target.id === 'share-modal') event.currentTarget.classList.add('hidden'); });
$('#copy-link').addEventListener('click', async () => {
  const url = roomUrl();
  if (!url) { showToast('Run start.bat to open a shareable HTTPS room'); return; }
  try { await navigator.clipboard.writeText(url); $('#copy-link').textContent = 'Copied!'; showToast('Room link copied to clipboard'); setTimeout(() => $('#copy-link').textContent = 'Copy link', 1600); }
  catch { showToast('Select and copy the room link'); }
});
function updateRoomAddress(nextRoom, historyMode, creator) {
  if (historyMode === 'none') return;
  const nextUrl = new URL(location.href);
  if (nextRoom) {
    nextUrl.searchParams.set('room', nextRoom);
    if (creator) nextUrl.searchParams.set('creator', '1');
    else nextUrl.searchParams.delete('creator');
  } else {
    nextUrl.searchParams.delete('room');
    nextUrl.searchParams.delete('creator');
  }
  const method = historyMode === 'replace' ? 'replaceState' : 'pushState';
  history[method]({ copadRoom: nextRoom }, '', `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`);
}
function clearRoomCursorState() {
  if (cursorFrame) cancelAnimationFrame(cursorFrame);
  cursorFrame = 0;
  for (const marker of cursors.values()) marker.remove();
  cursors.clear();
  remoteCursorAnchors.clear();
  peopleSnapshot.clear();
  localCursorMarker?.remove();
  localCursorMarker = null;
  localCursorHasPositioned = false;
  cursorDocumentHistory.length = 0;
  cursorVersionCache = '';
  localSelectionAnchors = null;
  localAnchorCacheKey = '';
  editor.classList.remove('copad-custom-caret');
}
function rememberLiveRoomContent() {
  if (!hasRoom || leavingDeletedRoom) return;
  roomScrollPositions.set(room, $('#paper').scrollTop);
  const fragment = document.createDocumentFragment();
  while (editor.firstChild) fragment.append(editor.firstChild);
  roomFragmentCache.delete(room);
  roomFragmentCache.set(room, { fragment, title: titleInput.value });
  while (roomFragmentCache.size > 4) roomFragmentCache.delete(roomFragmentCache.keys().next().value);
}
function switchRoom(nextRoom, { creator = false, created = false, title = '', historyMode = 'push', discardCurrent = false } = {}) {
  const nextId = String(nextRoom || '');
  if (nextId && !/^[a-z\d_-]{1,80}$/i.test(nextId)) return false;
  if (nextId === room) return true;
  if (roomSwitchTimer) clearTimeout(roomSwitchTimer);
  const generation = ++roomSwitchGeneration;
  const paperWrap = $('.paper-wrap');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!reduceMotion) paperWrap.classList.add('room-switch-out');
  editor.contentEditable = 'false';
  titleInput.disabled = true;
  colorPopover.classList.add('hidden');
  highlightPopover.classList.add('hidden');
  fontPopover.classList.add('hidden');
  selectionMenu.classList.add('hidden');

  const commitSwitch = () => {
    roomSwitchTimer = 0;
    if (generation !== roomSwitchGeneration) return;
    const previousId = room;
    if (hasRoom && !nextId) {
      if (unicodePresenceInFlight) unicodePresenceRefreshQueued = true;
      leaveUnicodePresence();
    }
    if (!discardCurrent) rememberLiveRoomContent();
    else {
      roomFragmentCache.delete(previousId);
      roomScrollPositions.delete(previousId);
    }

    const oldProvider = provider;
    provider = null;
    try { oldProvider?.awareness.setLocalState(null); } catch { }
    try { oldProvider?.destroy(); } catch (error) { console.warn('Could not close the previous room connection', error); }
    const oldPersistence = persistence;
    persistence = null;
    const oldDoc = doc;
    try { undoManager?.destroy(); } catch { }
    undoManager = null;
    sharedText = null;
    sharedTitle = null;
    applyingRemote = false;
    documentRenderPending = false;
    remoteRenderQueued = false;
    clearRoomCursorState();
    activeImageFigure = null;
    imageResizeDrag = null;
    draggedImage = null;
    imageResizeHandle.classList.add('hidden');
    imageDeleteHandle.classList.add('hidden');
    markerStrokeStart = null;
    hideMarkerCursor();
    const selection = getSelection();
    selection?.removeAllRanges();
    savedSelection = null;
    contextSelection = null;

    room = nextId;
    hasRoom = Boolean(room);
    leavingDeletedRoom = false;
    if (hasRoom) localStorage.setItem('copad-last-room', room);
    else if (historyMode !== 'none') localStorage.removeItem('copad-last-room');
    const cachedRoom = hasRoom ? roomFragmentCache.get(room) : null;
    if (cachedRoom) {
      roomFragmentCache.delete(room);
      localRoomHtml = null;
      localRoomTitle = cachedRoom.title;
      editor.replaceChildren(cachedRoom.fragment);
    } else {
      localRoomHtml = hasRoom ? localStorage.getItem(`margin-note-${room}`) : null;
      localRoomTitle = hasRoom ? localStorage.getItem(`copad-title-${room}`) || '' : '';
      editor.innerHTML = localRoomHtml === null ? '' : sanitizeHTML(localRoomHtml);
      if (localRoomHtml !== null) localRoomHtml = editor.innerHTML;
    }
    hasLocalRoomCopy = Boolean(cachedRoom || localRoomHtml !== null || localRoomTitle);
    const roomTitleHint = title || unicodeRooms.get(room)?.title || readRoomHistory().find((record) => record.id === room)?.title || '';
    if (!hasLocalRoomCopy && roomTitleHint) localRoomTitle = roomTitleHint;
    roomCreator = hasRoom && (creator || hasLocalRoomCopy);
    roomAwaitingRemoteSync = hasRoom && !hasLocalRoomCopy && !creator && !created;
    roomName = hasRoom ? `ROOM ${room.toUpperCase()}` : 'NO ROOM OPEN';
    $('#room-name').textContent = roomName;
    titleInput.value = localRoomTitle || 'A place for your thoughts';
    if (cachedRoom) {
      localRoomHtml = editor.innerHTML;
      localRoomTitle = titleInput.value;
    }
    document.documentElement.classList.toggle('empty-lobby', !hasRoom);
    document.documentElement.classList.remove('room-loading');
    clearTimeout(roomRevealTimer);
    updateEditorPlaceholder();
    updateStats();
    const paper = $('#paper');
    paper.scrollTop = roomScrollPositions.get(room) || 0;
    updateRoomAddress(room, historyMode, creator);
    if (hasRoom) rememberRoom(titleInput.value, false);
    clearTimeout(roomRevealTimer);
    if (roomAwaitingRemoteSync) roomRevealTimer = setTimeout(revealRoomContent, 3500);
    renderRoomHistory();
    updateUndoControls();
    $('#sync-state').textContent = hasRoom ? 'loading this device' : 'no room open';
    $('#sync-state').previousElementSibling.classList.remove('offline');
    doc = new Y.Doc();
    if (oldPersistence) {
      try {
        Promise.resolve(oldPersistence.destroy()).catch((error) => console.warn('Could not close saved data for the previous room', error)).finally(() => {
          try { oldDoc.destroy(); } catch { }
        });
      } catch (error) {
        console.warn('Could not close saved data for the previous room', error);
        try { oldDoc.destroy(); } catch { }
      }
    } else {
      try { oldDoc.destroy(); } catch { }
    }
    persistence = hasRoom ? new IndexeddbPersistence(`copad-${room}`, doc) : null;
    renderPeople();
    if (hasRoom) {
      connectRoom();
      void heartbeatUnicodePresence();
    } else {
      editor.contentEditable = 'true';
      titleInput.disabled = false;
    }
    updateLocalCursor();
    if (!roomAwaitingRemoteSync) {
      if (!reduceMotion) requestAnimationFrame(() => paperWrap.classList.remove('room-switch-out'));
      else paperWrap.classList.remove('room-switch-out');
    }
  };

  if (reduceMotion) commitSwitch();
  else roomSwitchTimer = setTimeout(commitSwitch, 100);
  return true;
}
window.addEventListener('popstate', () => {
  const target = new URLSearchParams(location.search);
  const targetRoom = target.get('room') || '';
  const targetRecord = readRoomHistory().find((record) => record.id === targetRoom) || unicodeRooms.get(targetRoom);
  switchRoom(targetRoom, { creator: target.get('creator') === '1', title: targetRecord?.title || '', historyMode: 'none' });
});
function createRoom() {
  const next = Math.random().toString(36).slice(2, 9);
  switchRoom(next, { creator: true, created: true });
}
$('#new-note').addEventListener('click', createRoom);
$('#create-first-room').addEventListener('click', createRoom);
window.addEventListener('pagehide', () => {
  try { saveRoomLocally(); }
  catch (error) { console.warn('Could not save this room while leaving', error); }
  leaveUnicodePresence();
  if (!provider) return;
  // Send an explicit awareness removal before closing the socket. The server
  // also expires missed heartbeats, but pagehide lets collaborators see a
  // clean leave immediately when someone closes or navigates away.
  try { provider.awareness.setLocalState(null); }
  catch (error) { console.warn('Could not announce that this writer left', error); }
  try { provider.disconnect(); }
  catch (error) { console.warn('Could not close the room connection cleanly', error); }
});
window.addEventListener('pageshow', (event) => {
  if (!event.persisted || !provider) return;
  setAwarenessUser();
  provider.awareness.setLocalStateField('cursor', null);
  provider.connect();
});
function printNoteAsPdf() {
  saveRoomLocally();
  const date = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const safeTitle = (titleInput.value.trim() || 'Untitled note').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').slice(0, 80);
  const previousTitle = document.title;
  document.title = `CoPad - ${safeTitle} - ${date}`;
  window.addEventListener('afterprint', () => { document.title = previousTitle; }, { once: true });
  showToast('Choose “Save as PDF” in the print window');
  window.print();
}
$('#save-room').addEventListener('click', printNoteAsPdf);
document.addEventListener('keydown', (event) => {
  const noteHasFocus = event.target === titleInput || editor.contains(event.target);
  if (noteHasFocus && (event.ctrlKey || event.metaKey) && !event.altKey && !event.isComposing) {
    const key = event.key.toLowerCase();
    const historyAction = key === 'z' ? (event.shiftKey ? 'redo' : 'undo') : key === 'y' ? 'redo' : null;
    if (historyAction && performRoomHistoryAction(historyAction)) { event.preventDefault(); return; }
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault();
    saveRoomLocally(true);
  }
});

function preloadKeySounds() {
  if (!soundOn || keySoundLoad) return;
  try {
    keySoundContext ||= new (window.AudioContext || window.webkitAudioContext)();
    keySoundLoad = Promise.all(Array.from({ length: 32 }, async (_, index) => {
      const filename = `keypress-${String(index + 1).padStart(3, '0')}.wav`;
      const response = await fetch(`/assets/key-sounds/${filename}`);
      if (!response.ok) throw new Error(`Could not load ${filename}`);
      return keySoundContext.decodeAudioData(await response.arrayBuffer());
    })).then((buffers) => { keySoundBuffers = buffers; }).catch(() => { keySoundLoad = null; });
  } catch { keySoundLoad = null; }
}
function shouldPlayKeySound(event) {
  if (!soundOn) return false;
  if (event.inputType === 'insertText' && event.data) return true;
  return ['deleteContentBackward', 'deleteWordBackward', 'deleteSoftLineBackward', 'deleteHardLineBackward', 'deleteEntireSoftLine'].includes(event.inputType);
}
function playTypeSound() {
  if (!soundOn || !keySoundBuffers?.length) return;
  if (keySoundContext.state === 'suspended') keySoundContext.resume().catch(() => {});
  let index = Math.floor(Math.random() * keySoundBuffers.length);
  if (keySoundBuffers.length > 1 && index === lastKeySound) index = (index + 1 + Math.floor(Math.random() * (keySoundBuffers.length - 1))) % keySoundBuffers.length;
  lastKeySound = index;
  const source = keySoundContext.createBufferSource();
  const gain = keySoundContext.createGain();
  source.buffer = keySoundBuffers[index];
  gain.gain.value = .34;
  source.connect(gain);
  gain.connect(keySoundContext.destination);
  activeKeySounds.add(source);
  source.addEventListener('ended', () => activeKeySounds.delete(source), { once: true });
  source.start();
}
function updateSoundControl() {
  $('#sound-toggle').querySelector('span:last-child').textContent = soundOn ? 'sound on' : 'sound off';
  $('#sound-toggle').setAttribute('aria-pressed', String(soundOn));
}
let spellCheckOn = localStorage.getItem('copad-spellcheck') === 'on';
function updateSpellcheckControl() {
  editor.spellcheck = spellCheckOn;
  titleInput.spellcheck = spellCheckOn;
  editor.setAttribute('spellcheck', String(spellCheckOn));
  titleInput.setAttribute('spellcheck', String(spellCheckOn));
  const button = $('#spellcheck-toggle');
  button.querySelector('span:last-child').textContent = spellCheckOn ? 'spell on' : 'spell off';
  button.querySelector('.spellcheck-icon').textContent = spellCheckOn ? '✓' : '–';
  button.title = spellCheckOn ? 'Turn spell check off' : 'Turn spell check on';
  button.setAttribute('aria-label', button.title);
  button.setAttribute('aria-pressed', String(spellCheckOn));
}
$('#spellcheck-toggle').addEventListener('click', () => {
  spellCheckOn = !spellCheckOn;
  localStorage.setItem('copad-spellcheck', spellCheckOn ? 'on' : 'off');
  updateSpellcheckControl();
});
updateSpellcheckControl();
$('#sound-toggle').addEventListener('click', () => {
  soundOn = !soundOn;
  localStorage.setItem('copad-sound', soundOn ? 'on' : 'off');
  updateSoundControl();
  if (soundOn) { preloadKeySounds(); showToast('Typewriter sounds on'); }
  else {
    for (const source of activeKeySounds) { try { source.stop(); } catch { /* already ended */ } }
    activeKeySounds.clear();
  }
});
updateSoundControl();
preloadKeySounds();
rememberRoom(localRoomTitle || titleInput.value);
renderRoomHistory();
namePromise.then(() => initializeUnicode());
const savedTheme = localStorage.getItem('copad-theme') || 'light';
document.documentElement.dataset.theme = savedTheme;
function updateThemeControl() {
  const dark = document.documentElement.dataset.theme === 'dark';
  const label = dark ? 'light mode' : 'dark mode';
  $('#theme-color').content = dark ? '#232520' : '#eeeae0';
  $('#theme-toggle').title = `Switch to ${label}`;
  $('#theme-toggle').setAttribute('aria-label', `Switch to ${label}`);
  $('#theme-toggle').querySelector('span:last-child').textContent = label;
  $('#theme-toggle').querySelector('.theme-icon').textContent = dark ? '☼' : '◐';
}
$('#theme-toggle').addEventListener('click', () => {
  const nextTheme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = nextTheme;
  localStorage.setItem('copad-theme', nextTheme);
  updateThemeControl();
});
updateThemeControl();
document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); openShare(); }
  if (event.key === 'Escape') { closeNameDialog(); $('#share-modal').classList.add('hidden'); colorPopover.classList.add('hidden'); highlightPopover.classList.add('hidden'); fontPopover.classList.add('hidden'); selectionMenu.classList.add('hidden'); }
});

updateStats();
if (hasRoom) connectRoom();
