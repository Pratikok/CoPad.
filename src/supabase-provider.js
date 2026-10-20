import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import { createSupabaseClient } from './supabase-client.js';

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const MESSAGE_SYNC_REQUEST = 2;

const SYNC_DEBOUNCE_MS = 400;
const PRESENCE_INTERVAL_MS = 4000;
const PRESENCE_TTL_MS = 30000;
const MAX_UPDATE_SIZE = 1_500_000;

function toBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function fromBase64(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function createSupabaseProvider(roomId, ydoc, { awareness, user, supabaseUrl, supabaseAnonKey } = {}) {
  const channelName = `copad-room:${roomId}`;
  const supabase = createSupabaseClient(supabaseUrl, supabaseAnonKey);
  const doc = ydoc;
  const aw = awareness || new awarenessProtocol.Awareness(doc);
  const localState = { user: user || null };

  let connected = false;
  let destroyed = false;
  let channel = null;
  let syncTimer = null;
  let presenceTimer = null;
  const remoteOrigins = new Set();
  const peers = new Set();
  let persistenceBusy = false;
  let initialLoadDone = false;

  const encoding = Y.encoding;
  const decoding = Y.decoding;

  function emitStatus() {
    const status = connected ? 'connected' : 'disconnected';
    doc.emit('status', [{ status }]);
    if (awareness) doc.emit('awareness', [{ added: [], updated: [], removed: [], origin: null }]);
  }

  function schedulePersistence() {
    if (syncTimer) return;
    syncTimer = setTimeout(() => {
      syncTimer = null;
      void persistState();
    }, SYNC_DEBOUNCE_MS);
  }

  async function persistState() {
    if (persistenceBusy || destroyed) return;
    persistenceBusy = true;
    try {
      const state = Y.encodeStateAsUpdate(doc);
      const stateVector = Y.encodeStateVector(doc);
      const payload = {
        room_id: roomId,
        state: toBase64(state),
        state_vector: toBase64(stateVector),
        updated_at: new Date().toISOString(),
      };
      const { error } = await supabase.from('copad_documents').upsert(payload, { onConflict: 'room_id' });
      if (error) console.warn('copad: could not persist document', error.message);
    } catch (err) {
      console.warn('copad: persist error', err?.message || err);
    } finally {
      persistenceBusy = false;
    }
  }

  async function loadInitialState() {
    try {
      const { data, error } = await supabase
        .from('copad_documents')
        .select('state')
        .eq('room_id', roomId)
        .maybeSingle();
      if (error) {
        console.warn('copad: could not load document', error.message);
      } else if (data?.state) {
        const stateBytes = fromBase64(data.state);
        if (stateBytes.length) {
          remoteOrigins.add('db');
          Y.applyUpdate(doc, stateBytes, 'db');
          remoteOrigins.delete('db');
        }
      }
    } catch (err) {
      console.warn('copad: load error', err?.message || err);
    } finally {
      initialLoadDone = true;
      doc.emit('synced', [true]);
      schedulePersistence();
    }
  }

  function broadcastUpdate(update, origin) {
    if (destroyed || !channel) return;
    if (update.length > MAX_UPDATE_SIZE) {
      persistState();
      return;
    }
    channel.send({
      type: 'broadcast',
      event: 'u',
      payload: { u: toBase64(update), o: origin === 'db' ? 'db' : 'peer' },
    });
  }

  function handleRemoteUpdate(payload) {
    if (!payload?.u) return;
    try {
      const update = fromBase64(payload.u);
      remoteOrigins.add('remote');
      Y.applyUpdate(doc, update, 'remote');
      remoteOrigins.delete('remote');
      schedulePersistence();
    } catch (err) {
      console.warn('copad: could not apply remote update', err?.message || err);
    }
  }

  function handleRemoteAwareness(payload) {
    if (!payload?.a) return;
    try {
      const update = fromBase64(payload.a);
      awarenessProtocol.applyAwarenessUpdate(aw, update, 'remote');
    } catch (err) {
      console.warn('copad: could not apply awareness', err?.message || err);
    }
  }

  function handleSyncRequest(payload) {
    if (!channel) return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(encoder, doc);
    channel.send({
      type: 'broadcast',
      event: 'sync',
      payload: { s: toBase64(encoding.toUint8Array(encoder)), from: clientId() },
    });
  }

  function handleRemoteSync(payload) {
    if (!payload?.s) return;
    try {
      const decoder = decoding.createDecoder(fromBase64(payload.s));
      const messageType = decoding.readVarUint(decoder);
      if (messageType === MESSAGE_SYNC) {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_SYNC);
        syncProtocol.readSyncStep1(decoder, encoder, doc);
        if (encoding.length(encoder) > 1) {
          channel.send({
            type: 'broadcast',
            event: 'u',
            payload: { u: toBase64(encoding.toUint8Array(encoder)), o: 'sync' },
          });
        }
      }
    } catch (err) {
      console.warn('copad: could not handle sync', err?.message || err);
    }
  }

  function clientId() { return doc.clientID; }

  function sendAwareness() {
    if (destroyed || !channel) return;
    const update = awarenessProtocol.encodeAwarenessUpdate(aw, [doc.clientID]);
    if (update.length > MAX_UPDATE_SIZE) return;
    channel.send({
      type: 'broadcast',
      event: 'a',
      payload: { a: toBase64(update), c: doc.clientID },
    });
  }

  function sendSyncRequest() {
    if (!channel) return;
    channel.send({ type: 'broadcast', event: 'sr', payload: { c: doc.clientID } });
  }

  function startPresence() {
    clearInterval(presenceTimer);
    sendAwareness();
    presenceTimer = setInterval(() => {
      if (!destroyed && connected) {
        sendAwareness();
        aw.setLocalStateField('heartbeat', Date.now());
        sendAwareness();
        aw.setLocalStateField('heartbeat', null);
      }
    }, PRESENCE_INTERVAL_MS);
  }

  function pruneStaleAwareness() {
    const states = aw.getStates();
    const now = Date.now();
    const remove = [];
    for (const [client, state] of states) {
      if (client === doc.clientID) continue;
      const lastSeen = state?.heartbeat || state?.t || 0;
      if (lastSeen && now - lastSeen > PRESENCE_TTL_MS) remove.push(client);
    }
    if (remove.length) {
      awarenessProtocol.removeAwarenessStates(aw, remove, 'timeout');
      if (awareness) doc.emit('awareness', [{ added: [], updated: [], removed: remove, origin: null }]);
    }
  }

  async function connect() {
    if (connected || destroyed) return;
    connected = true;
    channel = supabase.channel(channelName, {
      config: { broadcast: { self: false }, presence: { key: String(doc.clientID) } },
    });

    channel.on('broadcast', { event: 'u' }, ({ payload }) => handleRemoteUpdate(payload));
    channel.on('broadcast', { event: 'a' }, ({ payload }) => handleRemoteAwareness(payload));
    channel.on('broadcast', { event: 'sr' }, ({ payload }) => handleSyncRequest(payload));
    channel.on('broadcast', { event: 'sync' }, ({ payload }) => {
      if (payload?.from === doc.clientID) return;
      handleRemoteSync(payload);
    });

    channel.on('presence', { event: 'join' }, ({ key }) => {
      if (key !== String(doc.clientID)) {
        peers.add(key);
        sendSyncRequest();
      }
    });
    channel.on('presence', { event: 'leave' }, ({ key }) => {
      peers.delete(key);
      const id = Number(key);
      if (Number.isFinite(id)) {
        awarenessProtocol.removeAwarenessStates(aw, [id], 'left');
        if (awareness) doc.emit('awareness', [{ added: [], updated: [], removed: [id], origin: null }]);
      }
    });

    try {
      await channel.subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          await channel.track({ key: String(doc.clientID), t: Date.now() });
          await loadInitialState();
          sendSyncRequest();
          startPresence();
          setInterval(pruneStaleAwareness, PRESENCE_INTERVAL_MS);
          emitStatus();
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          connected = false;
          emitStatus();
        }
      });
    } catch (err) {
      console.warn('copad: channel subscribe error', err?.message || err);
      connected = false;
      emitStatus();
    }
  }

  function disconnect() {
    connected = false;
    if (syncTimer) { clearTimeout(syncTimer); syncTimer = null; }
    if (presenceTimer) { clearInterval(presenceTimer); presenceTimer = null; }
    if (channel) {
      try { channel.untrack(); } catch { /* already unsubscribed */ }
      try { supabase.removeChannel(channel); } catch { /* already removed */ }
      channel = null;
    }
    emitStatus();
  }

  doc.on('update', (update, origin) => {
    if (remoteOrigins.has(origin) || origin === 'db' || origin === 'remote') {
      schedulePersistence();
      return;
    }
    broadcastUpdate(update, origin);
    schedulePersistence();
  });

  aw.on('update', ({ added, updated, removed }) => {
    if (destroyed || !connected) return;
    sendAwareness();
  });

  function setAwarenessField(field, value) {
    aw.setLocalStateField(field, value);
    sendAwareness();
  }

  function setLocalStateField(field, value) {
    aw.setLocalStateField(field, value);
    sendAwareness();
  }

  function getLocalState() {
    return aw.getLocalState();
  }

  function getAwareness() {
    return aw;
  }

  function setUser(userObj) {
    localState.user = userObj;
    aw.setLocalStateField('user', userObj);
    sendAwareness();
  }

  return {
    awareness: aw,
    connect,
    disconnect,
    destroy() {
      destroyed = true;
      disconnect();
      try { aw.destroy(); } catch { /* already destroyed */ }
    },
    setAwarenessField,
    setLocalStateField,
    getLocalState,
    getAwareness,
    setUser,
    get status() { return connected ? 'connected' : 'disconnected'; },
    get channel() { return channel; },
  };
}
