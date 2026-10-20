import * as Y from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness';
import { createSupabaseClient } from './supabase-client.js';

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

export function createSupabaseProvider(roomId, ydoc, { awareness, user } = {}) {
  const channelName = `copad-room:${roomId}`;
  const supabase = createSupabaseClient();
  const doc = ydoc;
  const aw = awareness || new awarenessProtocol.Awareness(doc);

  let connected = false;
  let destroyed = false;
  let channel = null;
  let syncTimer = null;
  let presenceTimer = null;
  let pruneTimer = null;
  let persistenceBusy = false;
  const remoteOrigins = new Set();
  const statusListeners = new Set();
  const syncedListeners = new Set();

  function emitStatus() {
    const status = connected ? 'connected' : 'disconnected';
    statusListeners.forEach((fn) => fn({ status }));
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
      syncedListeners.forEach((fn) => fn(true));
      schedulePersistence();
    }
  }

  function broadcastUpdate(update) {
    if (destroyed || !channel || !connected) return;
    if (update.length > MAX_UPDATE_SIZE) {
      persistState();
      return;
    }
    channel.send({
      type: 'broadcast',
      event: 'u',
      payload: { u: toBase64(update) },
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

  function sendAwareness() {
    if (destroyed || !channel || !connected) return;
    const update = awarenessProtocol.encodeAwarenessUpdate(aw, [doc.clientID]);
    if (update.length > MAX_UPDATE_SIZE) return;
    channel.send({
      type: 'broadcast',
      event: 'a',
      payload: { a: toBase64(update), c: doc.clientID },
    });
  }

  function sendSyncRequest() {
    if (!channel || !connected) return;
    channel.send({ type: 'broadcast', event: 'sr', payload: { c: doc.clientID } });
  }

  function handleSyncRequest() {
    if (!channel || !connected) return;
    const stateVector = Y.encodeStateVector(doc);
    channel.send({
      type: 'broadcast',
      event: 'sv',
      payload: { sv: toBase64(stateVector), c: doc.clientID },
    });
  }

  function handleStateVector(payload) {
    if (!channel || !connected || payload?.c === doc.clientID) return;
    try {
      const remoteSv = fromBase64(payload.sv);
      const missingUpdate = Y.encodeStateAsUpdate(doc, remoteSv);
      if (missingUpdate.length > 1) {
        channel.send({
          type: 'broadcast',
          event: 'u',
          payload: { u: toBase64(missingUpdate) },
        });
      }
    } catch (err) {
      console.warn('copad: could not handle state vector', err?.message || err);
    }
  }

  function startPresence() {
    clearInterval(presenceTimer);
    sendAwareness();
    presenceTimer = setInterval(() => {
      if (!destroyed && connected) {
        aw.setLocalStateField('t', Date.now());
        sendAwareness();
      }
    }, PRESENCE_INTERVAL_MS);
  }

  function pruneStaleAwareness() {
    const states = aw.getStates();
    const now = Date.now();
    const remove = [];
    for (const [client, state] of states) {
      if (client === doc.clientID) continue;
      const lastSeen = state?.t || 0;
      if (lastSeen && now - lastSeen > PRESENCE_TTL_MS) remove.push(client);
    }
    if (remove.length) {
      awarenessProtocol.removeAwarenessStates(aw, remove, 'timeout');
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
    channel.on('broadcast', { event: 'sr' }, () => handleSyncRequest());
    channel.on('broadcast', { event: 'sv' }, ({ payload }) => handleStateVector(payload));

    channel.on('presence', { event: 'join' }, ({ key }) => {
      if (key !== String(doc.clientID)) {
        sendSyncRequest();
      }
    });
    channel.on('presence', { event: 'leave' }, ({ key }) => {
      const id = Number(key);
      if (Number.isFinite(id)) {
        awarenessProtocol.removeAwarenessStates(aw, [id], 'left');
      }
    });

    try {
      await channel.subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          await channel.track({ key: String(doc.clientID), t: Date.now() });
          await loadInitialState();
          sendSyncRequest();
          startPresence();
          pruneTimer = setInterval(pruneStaleAwareness, PRESENCE_INTERVAL_MS);
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
    if (pruneTimer) { clearInterval(pruneTimer); pruneTimer = null; }
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
    broadcastUpdate(update);
    schedulePersistence();
  });

  aw.on('update', () => {
    if (destroyed || !connected) return;
    sendAwareness();
  });

  function on(event, fn) {
    if (event === 'status') statusListeners.add(fn);
    else if (event === 'synced') syncedListeners.add(fn);
    return () => {
      statusListeners.delete(fn);
      syncedListeners.delete(fn);
    };
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
    on,
    setLocalStateField(field, value) {
      aw.setLocalStateField(field, value);
      sendAwareness();
    },
    getLocalState() { return aw.getLocalState(); },
    setUser(userObj) {
      aw.setLocalStateField('user', userObj);
      sendAwareness();
    },
    get status() { return connected ? 'connected' : 'disconnected'; },
  };
}
