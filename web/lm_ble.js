import {
  decodePeerSnapshot,
  decodeStatus,
  decodeText,
  decodeTextAck,
} from './lm_packets.js';

export const LM_BLE_UUIDS = Object.freeze({
  service: '4c4d0001-9a1b-4c6d-8e2f-1a2b3c4d5e6f',
  gpsRx: '4c4d0002-9a1b-4c6d-8e2f-1a2b3c4d5e6f',
  peerTx: '4c4d0003-9a1b-4c6d-8e2f-1a2b3c4d5e6f',
  status: '4c4d0004-9a1b-4c6d-8e2f-1a2b3c4d5e6f',
  textRx: '4c4d0005-9a1b-4c6d-8e2f-1a2b3c4d5e6f',
  textTx: '4c4d0006-9a1b-4c6d-8e2f-1a2b3c4d5e6f',
});

const RECONNECT_DELAYS = [2, 5, 10, 20, 30];

function errorText(error) {
  if (!error) {
    return 'Error desconocido';
  }
  if (error.name && error.message) {
    return `${error.name}: ${error.message}`;
  }
  return error.message || String(error);
}

function valueToBytes(value) {
  if (value instanceof DataView) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return null;
}

async function writeCharacteristic(characteristic, bytes, preferWithoutResponse) {
  const properties = characteristic.properties || {};
  const canWithoutResponse = properties.writeWithoutResponse !== false;
  const canWithResponse = properties.write !== false;

  if (
    preferWithoutResponse &&
    canWithoutResponse &&
    typeof characteristic.writeValueWithoutResponse === 'function'
  ) {
    try {
      await characteristic.writeValueWithoutResponse(bytes);
      return;
    } catch (error) {
      if (!canWithResponse || typeof characteristic.writeValueWithResponse !== 'function') {
        throw error;
      }
    }
  }

  if (canWithResponse && typeof characteristic.writeValueWithResponse === 'function') {
    try {
      await characteristic.writeValueWithResponse(bytes);
      return;
    } catch (error) {
      if (
        !canWithoutResponse ||
        typeof characteristic.writeValueWithoutResponse !== 'function'
      ) {
        throw error;
      }
    }
  }

  if (canWithoutResponse && typeof characteristic.writeValueWithoutResponse === 'function') {
    await characteristic.writeValueWithoutResponse(bytes);
    return;
  }

  if (typeof characteristic.writeValue === 'function') {
    await characteristic.writeValue(bytes);
    return;
  }

  throw new Error('La característica BLE no permite escritura');
}

export class LmBle extends EventTarget {
  constructor() {
    super();
    this.device = null;
    this.server = null;
    this.chars = null;
    this.status = null;
    this.peers = [];
    this.hubUptimeS = 0;
    this.lastStatusAt = null;
    this.lastPeersAt = null;
    this.lastPeersAt = null;
    this.lastEvent = null;
    this.error = null;
    this.connected = false;
    this.connecting = false;
    this.shouldReconnect = false;
    this.manualDisconnect = false;
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
    this.listenedDevice = null;
    this.disconnectHandler = null;
    this.valueHandlers = null;
    this.gpsWriteInFlight = false;
    this.textWriteInFlight = false;
  }

  get supported() {
    return typeof navigator !== 'undefined' && 'bluetooth' in navigator;
  }

  get reconnecting() {
    return this.shouldReconnect && !this.connected && !this.connecting;
  }

  get deviceName() {
    return this.device?.name || 'Nodo LM';
  }

  get deviceId() {
    return this.device?.id || '';
  }

  get textReady() {
    return Boolean(this.chars?.textRx && this.chars?.textTx);
  }

  get gpsReady() {
    return Boolean(this.chars?.gpsRx);
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  snapshot() {
    return {
      supported: this.supported,
      connected: this.connected,
      connecting: this.connecting,
      reconnecting: this.reconnecting,
      deviceName: this.deviceName,
      deviceId: this.deviceId,
      status: this.status,
      peers: this.peers,
      hubUptimeS: this.hubUptimeS,
      lastStatusAt: this.lastStatusAt,
      lastPeersAt: this.lastPeersAt,
      lastEvent: this.lastEvent,
      error: this.error,
      textReady: this.textReady,
      gpsReady: this.gpsReady,
    };
  }

  emitState() {
    this.emit('state', this.snapshot());
  }

  setError(message) {
    this.error = message;
    this.emitState();
  }

  setEvent(message) {
    this.lastEvent = message;
    this.emitState();
  }

  async requestAndConnect() {
    if (!this.supported) {
      this.setError('Web Bluetooth no está disponible en este navegador');
      return;
    }
    if (this.connected || this.connecting) {
      return;
    }
    try {
      this.error = null;
      this.lastEvent = 'Selecciona el nodo LM en el diálogo del navegador...';
      this.emitState();
      const device = await navigator.bluetooth.requestDevice({
        filters: [{ namePrefix: 'LM-' }],
        optionalServices: [LM_BLE_UUIDS.service],
      });
      await this.connectDevice(device);
    } catch (error) {
      if (error?.name === 'NotFoundError') {
        this.lastEvent = 'Selección cancelada';
        this.error = null;
        this.emitState();
        return;
      }
      this.error = `Conexión: ${errorText(error)}`;
      this.lastEvent = null;
      this.emitState();
    }
  }

  async connectDevice(device, { isReconnect = false } = {}) {
    if (!device) {
      return;
    }
    if (this.connecting) {
      return;
    }
    if (this.connected && this.device === device) {
      return;
    }
    if (this.device && this.device !== device) {
      await this.disconnect();
    }

    this.manualDisconnect = false;
    this.shouldReconnect = true;
    this.connecting = true;
    this.error = null;
    this.lastEvent = isReconnect
      ? `Reconectando con ${device.name || 'Nodo LM'}...`
      : `Conectando a ${device.name || 'Nodo LM'}...`;
    this.device = device;
    this.attachDisconnectListener(device);
    this.emitState();

    try {
      this.clearReconnectTimer();
      const server = await device.gatt.connect();
      this.server = server;
      const service = await server.getPrimaryService(LM_BLE_UUIDS.service);
      const gpsRx = await service.getCharacteristic(LM_BLE_UUIDS.gpsRx);
      const peerTx = await service.getCharacteristic(LM_BLE_UUIDS.peerTx);
      const status = await service.getCharacteristic(LM_BLE_UUIDS.status);
      const textRx = await service.getCharacteristic(LM_BLE_UUIDS.textRx);
      const textTx = await service.getCharacteristic(LM_BLE_UUIDS.textTx);

      this.chars = { gpsRx, peerTx, status, textRx, textTx };
      this.attachValueHandlers();
      await Promise.all([
        status.startNotifications(),
        peerTx.startNotifications(),
        textTx.startNotifications(),
      ]);
      const initial = await status.readValue();
      this.handleStatus(initial);

      this.connected = true;
      this.connecting = false;
      this.reconnectAttempt = 0;
      this.lastEvent = `Conectado a ${device.name || 'Nodo LM'}`;
      this.emitState();
    } catch (error) {
      this.cleanupChars();
      this.server = null;
      this.connected = false;
      this.connecting = false;
      this.error = `Conexión: ${errorText(error)}`;
      this.lastEvent = null;
      this.emitState();
      if (this.shouldReconnect && !this.manualDisconnect) {
        this.scheduleReconnect();
      }
    } finally {
      this.connecting = false;
      this.emitState();
    }
  }

  attachDisconnectListener(device) {
    if (this.listenedDevice === device) {
      return;
    }
    if (this.listenedDevice && this.disconnectHandler) {
      this.listenedDevice.removeEventListener(
        'gattserverdisconnected',
        this.disconnectHandler,
      );
    }
    this.listenedDevice = device;
    this.disconnectHandler = () => this.handleDisconnected(device);
    device.addEventListener('gattserverdisconnected', this.disconnectHandler);
  }

  attachValueHandlers() {
    if (!this.chars) {
      return;
    }
    this.valueHandlers = {
      status: (event) => this.handleStatus(event.target.value),
      peers: (event) => this.handlePeers(event.target.value),
      text: (event) => this.handleTextValue(event.target.value),
    };
    this.chars.status.addEventListener(
      'characteristicvaluechanged',
      this.valueHandlers.status,
    );
    this.chars.peerTx.addEventListener(
      'characteristicvaluechanged',
      this.valueHandlers.peers,
    );
    this.chars.textTx.addEventListener(
      'characteristicvaluechanged',
      this.valueHandlers.text,
    );
  }

  cleanupChars() {
    if (this.chars && this.valueHandlers) {
      this.chars.status.removeEventListener(
        'characteristicvaluechanged',
        this.valueHandlers.status,
      );
      this.chars.peerTx.removeEventListener(
        'characteristicvaluechanged',
        this.valueHandlers.peers,
      );
      this.chars.textTx.removeEventListener(
        'characteristicvaluechanged',
        this.valueHandlers.text,
      );
    }
    this.valueHandlers = null;
    this.chars = null;
  }

  handleStatus(value) {
    const bytes = valueToBytes(value);
    const parsed = decodeStatus(bytes);
    if (!parsed) {
      return;
    }
    this.status = parsed;
    this.lastStatusAt = Date.now();
    this.emitState();
  }

  handlePeers(value) {
    const bytes = valueToBytes(value);
    const parsed = decodePeerSnapshot(bytes);
    if (!parsed) {
      return;
    }
    this.peers = parsed.peers;
    this.hubUptimeS = parsed.hubUptimeS;
    this.lastPeersAt = Date.now();
    this.emitState();
  }

  handleTextValue(value) {
    const bytes = valueToBytes(value);
    const text = decodeText(bytes);
    if (text) {
      this.emit('text', text);
      return;
    }
    const ack = decodeTextAck(bytes);
    if (ack) {
      this.emit('ack', ack);
    }
  }

  handleDisconnected(device) {
    if (device && this.device && device !== this.device) {
      return;
    }
    const wasConnected = this.connected;
    this.connected = false;
    this.connecting = false;
    this.cleanupChars();
    this.server = null;
    this.status = null;
    this.peers = [];
    this.hubUptimeS = 0;
    this.lastStatusAt = null;
    this.lastPeersAt = null;
    if (this.manualDisconnect) {
      this.lastEvent = 'Desconectado';
      this.error = null;
    } else if (this.shouldReconnect) {
      this.error = null;
      this.lastEvent = 'Conexión perdida; reconectando...';
    } else {
      this.error = 'El nodo se desconectó';
      this.lastEvent = null;
    }
    this.emitState();
    if (wasConnected && this.shouldReconnect && !this.manualDisconnect) {
      this.scheduleReconnect();
    }
  }

  scheduleReconnect() {
    if (!this.shouldReconnect || this.reconnectTimer || !this.device) {
      return;
    }
    const index = Math.min(this.reconnectAttempt, RECONNECT_DELAYS.length - 1);
    const delay = RECONNECT_DELAYS[index];
    this.reconnectAttempt += 1;
    this.lastEvent = `Reconectando en ${delay} s...`;
    this.emitState();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.shouldReconnect || !this.device) {
        return;
      }
      this.connectDevice(this.device, { isReconnect: true });
    }, delay * 1000);
  }

  clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  async disconnect() {
    this.manualDisconnect = true;
    this.shouldReconnect = false;
    this.reconnectAttempt = 0;
    this.clearReconnectTimer();
    this.cleanupChars();
    this.server = null;
    this.connected = false;
    this.connecting = false;
    this.status = null;
    this.peers = [];
    this.hubUptimeS = 0;
    this.lastStatusAt = null;
    this.lastPeersAt = null;
    this.error = null;
    this.lastEvent = 'Desconectado';
    if (this.device?.gatt?.connected) {
      try {
        this.device.gatt.disconnect();
      } catch (_) {}
    }
    this.emitState();
  }

  async writeGps(bytes) {
    if (!this.connected || !this.chars?.gpsRx || this.gpsWriteInFlight) {
      return false;
    }
    this.gpsWriteInFlight = true;
    try {
      await writeCharacteristic(this.chars.gpsRx, bytes, true);
      return true;
    } catch (error) {
      this.error = `Envío GPS: ${errorText(error)}`;
      this.emitState();
      return false;
    } finally {
      this.gpsWriteInFlight = false;
    }
  }

  async sendText(bytes) {
    if (!this.connected || !this.chars?.textRx || this.textWriteInFlight) {
      return false;
    }
    this.textWriteInFlight = true;
    try {
      await writeCharacteristic(this.chars.textRx, bytes, false);
      this.error = null;
      return true;
    } catch (error) {
      this.error = `Envío de mensaje: ${errorText(error)}`;
      this.emitState();
      return false;
    } finally {
      this.textWriteInFlight = false;
    }
  }

  async getGrantedDevices() {
    if (!this.supported || typeof navigator.bluetooth.getDevices !== 'function') {
      return [];
    }
    try {
      return await navigator.bluetooth.getDevices();
    } catch (_) {
      return [];
    }
  }
}
