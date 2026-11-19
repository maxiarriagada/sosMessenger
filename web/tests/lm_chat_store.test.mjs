import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LM_CHAT_MAX_MESSAGES,
  LM_CHAT_STATUS,
  LM_CHAT_STORAGE_KEY,
  LmChatStore,
} from '../lm_chat_store.js';

class MemoryStorage {
  constructor() {
    this.values = new Map();
  }

  getItem(key) {
    return this.values.has(key) ? this.values.get(key) : null;
  }

  setItem(key, value) {
    this.values.set(key, String(value));
  }

  removeItem(key) {
    this.values.delete(key);
  }
}

function packet(overrides = {}) {
  return {
    msgId: 1,
    from: '5494',
    to: '*',
    fromBootId: 25701,
    sentAt: 1700000000,
    text: 'hola',
    broadcast: true,
    ...overrides,
  };
}

test('outgoing messages persist and reload', () => {
  const storage = new MemoryStorage();
  const store = new LmChatStore(storage);
  store.addOutgoing(packet({ msgId: 7 }));
  assert.equal(store.count, 1);
  assert.equal(store.messages[0].status, LM_CHAT_STATUS.sent);
  assert.equal(store.messages[0].outgoing, true);
  assert.ok(storage.getItem(LM_CHAT_STORAGE_KEY));

  const reloaded = new LmChatStore(storage);
  reloaded.load();
  assert.equal(reloaded.count, 1);
  assert.equal(reloaded.messages[0].msgId, 7);
  assert.equal(reloaded.messages[0].text, 'hola');
});

test('incoming messages are deduplicated', () => {
  const store = new LmChatStore(new MemoryStorage());
  store.addIncoming(packet({ msgId: 9, outgoing: false }));
  store.addIncoming(packet({ msgId: 9, outgoing: false }));
  assert.equal(store.count, 1);
  assert.equal(store.messages[0].outgoing, false);
  assert.equal(store.messages[0].status, LM_CHAT_STATUS.delivered);
});

test('ACK updates outgoing status', () => {
  const store = new LmChatStore(new MemoryStorage());
  store.addOutgoing(packet({ msgId: 11 }));
  store.applyAck({ msgId: 11, isError: false });
  assert.equal(store.messages[0].status, LM_CHAT_STATUS.delivered);
  store.applyAck({ msgId: 11, isError: true });
  assert.equal(store.messages[0].status, LM_CHAT_STATUS.failed);
});

test('history is trimmed to the maximum', () => {
  const store = new LmChatStore(new MemoryStorage());
  for (let index = 0; index < LM_CHAT_MAX_MESSAGES + 5; index += 1) {
    store.addOutgoing(packet({ msgId: index + 1, text: `mensaje ${index}` }));
  }
  assert.equal(store.count, LM_CHAT_MAX_MESSAGES);
  assert.equal(store.messages[0].msgId, 6);
  assert.equal(store.messages[store.count - 1].msgId, LM_CHAT_MAX_MESSAGES + 5);
});

test('clear removes messages and persists', () => {
  const storage = new MemoryStorage();
  const store = new LmChatStore(storage);
  store.addOutgoing(packet());
  store.clear();
  assert.equal(store.count, 0);
  assert.equal(storage.getItem(LM_CHAT_STORAGE_KEY), '[]');
});

test('invalid stored data is ignored', () => {
  const storage = new MemoryStorage();
  storage.setItem(LM_CHAT_STORAGE_KEY, '{not json');
  const store = new LmChatStore(storage);
  store.load();
  assert.equal(store.count, 0);
});
