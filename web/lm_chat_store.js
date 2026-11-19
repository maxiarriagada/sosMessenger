export const LM_CHAT_STORAGE_KEY = 'lm_chat_v1';
export const LM_CHAT_MAX_MESSAGES = 200;

export const LM_CHAT_STATUS = Object.freeze({
  pending: 'pending',
  sent: 'sent',
  delivered: 'delivered',
  failed: 'failed',
});

function defaultStorage() {
  try {
    return globalThis.localStorage;
  } catch (_) {
    return null;
  }
}

function sentAtOf(packet) {
  const seconds = Number(packet?.sentAt) || 0;
  if (seconds > 0) {
    return new Date(seconds * 1000).toISOString();
  }
  return new Date().toISOString();
}

function parseMessage(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const msgId = Number(value.msgId);
  const text = value.text;
  const sentAt = new Date(String(value.sentAt ?? ''));
  if (!Number.isFinite(msgId) || typeof text !== 'string' || Number.isNaN(sentAt.getTime())) {
    return null;
  }
  const status = Object.values(LM_CHAT_STATUS).includes(value.status)
    ? value.status
    : LM_CHAT_STATUS.sent;
  return {
    msgId: msgId >>> 0,
    from: String(value.from ?? ''),
    to: String(value.to ?? ''),
    fromBootId: Number(value.fromBootId) || 0,
    sentAt: sentAt.toISOString(),
    text,
    broadcast: value.broadcast === true,
    outgoing: value.outgoing === true,
    status,
    deliveredAt: value.deliveredAt ? String(value.deliveredAt) : null,
  };
}

export class LmChatStore extends EventTarget {
  constructor(storage = defaultStorage()) {
    super();
    this.storage = storage;
    this.messages = [];
  }

  get count() {
    return this.messages.length;
  }

  get pendingMessages() {
    return this.messages.filter(
      (message) => message.outgoing && message.status === LM_CHAT_STATUS.pending,
    );
  }

  load() {
    if (!this.storage) {
      return;
    }
    try {
      const raw = this.storage.getItem(LM_CHAT_STORAGE_KEY);
      if (!raw) {
        return;
      }
      const decoded = JSON.parse(raw);
      if (!Array.isArray(decoded)) {
        this.messages = [];
        return;
      }
      this.messages = decoded.map(parseMessage).filter(Boolean);
      this.trim();
      this.emitChange();
    } catch (_) {
      this.messages = [];
    }
  }

  addOutgoing(packet, status = LM_CHAT_STATUS.sent) {
    this.messages.push({
      msgId: Number(packet.msgId) >>> 0,
      from: String(packet.from ?? ''),
      to: String(packet.to ?? ''),
      fromBootId: Number(packet.fromBootId) || 0,
      sentAt: sentAtOf(packet),
      text: String(packet.text ?? ''),
      broadcast: packet.broadcast === true,
      outgoing: true,
      status: Object.values(LM_CHAT_STATUS).includes(status)
        ? status
        : LM_CHAT_STATUS.sent,
      deliveredAt: null,
    });
    this.trim();
    this.emitChange();
    this.persist();
  }

  addIncoming(packet) {
    const duplicate = this.messages.some(
      (message) =>
        !message.outgoing &&
        message.msgId === (Number(packet.msgId) >>> 0) &&
        message.from === String(packet.from ?? '') &&
        message.fromBootId === (Number(packet.fromBootId) || 0),
    );
    if (duplicate) {
      return;
    }
    this.messages.push({
      msgId: Number(packet.msgId) >>> 0,
      from: String(packet.from ?? ''),
      to: String(packet.to ?? ''),
      fromBootId: Number(packet.fromBootId) || 0,
      sentAt: sentAtOf(packet),
      text: String(packet.text ?? ''),
      broadcast: packet.broadcast === true,
      outgoing: false,
      status: LM_CHAT_STATUS.delivered,
      deliveredAt: new Date().toISOString(),
    });
    this.trim();
    this.emitChange();
    this.persist();
  }

  setStatus(msgId, status) {
    const id = Number(msgId) >>> 0;
    const index = this.messages.findIndex(
      (message) => message.outgoing && message.msgId === id,
    );
    if (index < 0 || !Object.values(LM_CHAT_STATUS).includes(status)) {
      return;
    }
    if (
      this.messages[index].status === status ||
      (this.messages[index].status === LM_CHAT_STATUS.delivered &&
        status === LM_CHAT_STATUS.sent)
    ) {
      return;
    }
    this.messages[index] = { ...this.messages[index], status };
    this.emitChange();
    this.persist();
  }

  applyAck(ack) {
    const msgId = Number(ack.msgId) >>> 0;
    const ackTo = String(ack.to ?? '');
    const ackFrom = String(ack.from ?? '');
    const index = this.messages.findIndex(
      (message) =>
        message.outgoing &&
        message.msgId === msgId &&
        (!ackTo || ackTo === message.from) &&
        (!ackFrom || ackFrom === message.to),
    );
    if (index < 0) {
      return;
    }
    const status = ack.isError ? LM_CHAT_STATUS.failed : LM_CHAT_STATUS.delivered;
    if (this.messages[index].status === status) {
      return;
    }
    this.messages[index] = {
      ...this.messages[index],
      status,
      deliveredAt: status === LM_CHAT_STATUS.delivered ? new Date().toISOString() : null,
    };
    this.emitChange();
    this.persist();
  }

  clear() {
    this.messages = [];
    this.emitChange();
    this.persist();
  }

  trim() {
    const excess = this.messages.length - LM_CHAT_MAX_MESSAGES;
    if (excess > 0) {
      this.messages.splice(0, excess);
    }
  }

  persist() {
    if (!this.storage) {
      return;
    }
    try {
      this.storage.setItem(LM_CHAT_STORAGE_KEY, JSON.stringify(this.messages));
    } catch (_) {}
  }

  emitChange() {
    this.dispatchEvent(new Event('change'));
  }
}
