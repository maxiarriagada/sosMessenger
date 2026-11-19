import { LmBle } from './lm_ble.js';
import { LM_CHAT_STATUS, LmChatStore } from './lm_chat_store.js';
import {
  bearingDegrees,
  formatDistance,
  formatHeading,
  formatRelative,
  normalizeHeading,
  relativeBearing,
  routeInfo,
} from './lm_geo.js';
import {
  LM_TEXT_FLAG_BROADCAST,
  encodeGpsPacket,
  encodeTextPacket,
  nowSeconds,
  randomMsgId,
  sourceName,
  utf8Length,
} from './lm_packets.js';

const $ = (id) => document.getElementById(id);
const NODE_STALE_MS = 8000;
const PEER_STALE_MS = 15000;
const ble = new LmBle();
const chat = new LmChatStore();
const isIos =
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

const state = {
  tab: 'monitor',
  grantedDevices: [],
  geoWatchId: null,
  geoActive: false,
  lastFix: null,
  gpsError: null,
  gpsSentCount: 0,
  lastGpsSent: null,
  lastGpsWriteAt: 0,
  gpsWriteInFlight: false,
  seq: 0,
  broadcast: true,
  target: null,
  peerSignature: '',
  sending: false,
  sosSending: false,
  installPrompt: null,
  toastTimer: null,
  renderedChatCount: 0,
  heading: null,
  headingSource: null,
  compassActive: false,
  lastHeadingRender: 0,
  map: null,
  mapMarkers: new Map(),
  mapPoints: [],
  mapHasCentered: false,
  navTarget: loadPreference('lm_nav_target_v1', null),
  showAllNodes: loadPreference('lm_show_all_nodes_v1', false),
  wakeLockEnabled: loadPreference('lm_wake_lock_v1', false),
  wakeLockSentinel: null,
  wakeLockError: null,
  navSignature: '',
  navLine: null,
  nodeIdentity: null,
  unread: 0,
  notifySupported: typeof Notification !== 'undefined',
  flushing: false,
};

function init() {
  chat.addEventListener('change', onChatChange);
  chat.load();
  bindEvents();
  ble.addEventListener('state', onBleState);
  ble.addEventListener('text', onIncomingText);
  ble.addEventListener('ack', onAck);
  window.addEventListener('beforeinstallprompt', onInstallPrompt);
  window.addEventListener('appinstalled', onInstalled);
  window.addEventListener('hashchange', onHashChange);
  registerServiceWorker();
  loadGrantedDevices();
  render();
  renderMessages();
  if (location.hash === '#map') {
    setTab('map');
  } else if (location.hash === '#chat') {
    setTab('chat');
  }
  document.addEventListener('visibilitychange', onVisibilityChange);
  setInterval(renderFreshness, 1000);
  if (state.wakeLockEnabled) {
    acquireWakeLock();
  }
}

function bindEvents() {
  $('connectBtn').addEventListener('click', async () => {
    await ble.requestAndConnect();
    await loadGrantedDevices();
  });
  $('disconnectBtn').addEventListener('click', async () => {
    await ble.disconnect();
    await loadGrantedDevices();
  });
  $('disconnectBtn2').addEventListener('click', async () => {
    await ble.disconnect();
    await loadGrantedDevices();
  });
  $('gpsBtn').addEventListener('click', toggleGps);
  $('compassBtn').addEventListener('click', toggleCompass);
  $('wakeLockToggle')?.addEventListener('change', (event) => {
    setWakeLock(event.target.checked);
  });
  $('mapCenterBtn').addEventListener('click', () => centerMap(true));
  $('navTargetSelect').addEventListener('change', (event) => {
    state.navTarget = event.target.value || null;
    savePreference('lm_nav_target_v1', state.navTarget);
    const snapshot = ble.snapshot();
    renderNavigation(snapshot);
    renderMap(snapshot);
  });
  $('showAllNodes').addEventListener('change', (event) => {
    state.showAllNodes = event.target.checked;
    savePreference('lm_show_all_nodes_v1', state.showAllNodes);
    renderMap(ble.snapshot());
    centerMap(true);
  });
  $('broadcastToggle').addEventListener('change', (event) => {
    state.broadcast = event.target.checked;
    renderChatMeta();
  });
  $('targetSelect').addEventListener('change', (event) => {
    state.target = event.target.value || null;
    renderChatMeta();
  });
  $('messageInput').addEventListener('input', (event) => {
    state.draft = event.target.value;
    renderChatMeta();
  });
  $('sendBtn').addEventListener('click', sendText);
  $('sosBtn')?.addEventListener('click', sendSos);
  $('clearChatBtn').addEventListener('click', () => {
    if (chat.count === 0) {
      return;
    }
    if (window.confirm('¿Borrar todo el historial de mensajes de este teléfono?')) {
      chat.clear();
    }
  });
  $('monitorTab').addEventListener('click', () => setTab('monitor', true));
  $('mapTab')?.addEventListener('click', () => setTab('map', true));
  $('chatTab').addEventListener('click', () => setTab('chat', true));
  $('installBtn').addEventListener('click', installApp);
  $('notifyBtn').addEventListener('click', requestNotifications);
}

function onBleState(snapshot) {
  if (snapshot.status) {
    state.nodeIdentity = {
      id: snapshot.status.nodeId,
      bootId: snapshot.status.bootId,
    };
  }
  render();
  flushPending();
}

function onIncomingText(event) {
  const message = event.detail;
  const before = chat.count;
  chat.addIncoming(message);
  if (chat.count === before) {
    return;
  }
  const viewingChat = state.tab === 'chat' && !document.hidden;
  if (!viewingChat) {
    state.unread += 1;
    notifyMessage(message);
  }
  toast(`Mensaje de ${message.from || 'peer'}`);
}

function onAck(event) {
  chat.applyAck(event.detail);
}

function onChatChange() {
  renderChatMeta();
  renderMessages();
  renderTabs();
}

function onHashChange() {
  if (location.hash === '#chat') {
    setTab('chat');
  } else if (location.hash === '#map') {
    setTab('map');
  } else {
    setTab('monitor');
  }
}

async function requestNotifications() {
  if (!state.notifySupported) {
    return;
  }
  try {
    const permission = await Notification.requestPermission();
    renderSupport(ble.snapshot());
    toast(
      permission === 'granted'
        ? 'Avisos activados'
        : permission === 'denied'
          ? 'Avisos bloqueados en el navegador'
          : 'Avisos no activados',
    );
  } catch (_) {
    toast('No se pudieron activar los avisos');
  }
}

function notifyMessage(message) {
  if (!state.notifySupported || Notification.permission !== 'granted') {
    return;
  }
  const title = `Mensaje de ${message.from || 'peer'}`;
  const options = {
    body: String(message.text ?? '').slice(0, 120),
    tag: `lm-${message.msgId}`,
    icon: './icons/icon-192.png',
    data: { url: './#chat' },
  };
  try {
    if (navigator.serviceWorker?.ready) {
      navigator.serviceWorker.ready
        .then((registration) => registration.showNotification(title, options))
        .catch(() => new Notification(title, options));
    } else {
      new Notification(title, options);
    }
  } catch (_) {}
}

async function flushPending() {
  if (state.flushing || !ble.connected || !ble.status) {
    return;
  }
  const pending = chat.pendingMessages;
  if (pending.length === 0) {
    return;
  }
  state.flushing = true;
  try {
    for (const message of pending) {
      if (!ble.connected || !ble.status) {
        break;
      }
      if (
        message.from !== ble.status.nodeId ||
        message.fromBootId !== ble.status.bootId
      ) {
        continue;
      }
      const sent = await ble.sendText(encodeTextPacket(packetFromMessage(message)));
      if (!sent) {
        break;
      }
      chat.setStatus(message.msgId, LM_CHAT_STATUS.sent);
    }
    if (chat.pendingMessages.length === 0) {
      toast('Mensajes pendientes enviados');
    }
  } finally {
    state.flushing = false;
  }
}

function onInstallPrompt(event) {
  event.preventDefault();
  state.installPrompt = event;
  renderSupport(ble.snapshot());
}

function onInstalled() {
  state.installPrompt = null;
  renderSupport(ble.snapshot());
}

async function loadGrantedDevices() {
  state.grantedDevices = await ble.getGrantedDevices();
  renderConnection(ble.snapshot());
}

function render() {
  const snapshot = ble.snapshot();
  renderHeader(snapshot);
  renderSupport(snapshot);
  renderConnection(snapshot);
  renderNode(snapshot);
  renderGps();
  renderPeers(snapshot);
  renderNavigation(snapshot);
  renderStaleBanner(snapshot);
  renderMap(snapshot);
  renderEvent(snapshot);
  renderChatMeta();
  renderTabs();
  if (chat.count === 0) {
    renderMessages();
  }
}

function renderHeader(snapshot) {
  const status = snapshot.status;
  const subtitle = snapshot.connected
    ? `${status?.nodeId || snapshot.deviceName}${snapshot.deviceId ? ` · ${snapshot.deviceId}` : ''}`
    : snapshot.connecting
      ? 'Conectando...'
      : snapshot.reconnecting
        ? 'Reconectando...'
        : 'Sin conexión';
  $('connectionSubtitle').textContent = subtitle;
  const badge = snapshot.connected
    ? ['Conectado', 'ok']
    : snapshot.connecting
      ? ['Conectando', 'info']
      : snapshot.reconnecting
        ? ['Reconectando', 'warn']
        : ['Desconectado', 'muted'];
  setBadge($('connBadge'), badge[0], badge[1]);
  $('disconnectBtn').hidden = !snapshot.connected;
}

function renderSupport(snapshot) {
  $('supportBanner').hidden = snapshot.supported || isIos;
  $('iosBanner').hidden = !(isIos && !snapshot.supported);
  $('installBanner').hidden = !state.installPrompt || isStandalone();
  const notifyBtn = $('notifyBtn');
  notifyBtn.hidden = !state.notifySupported;
  const permission = state.notifySupported ? Notification.permission : 'denied';
  notifyBtn.disabled = permission === 'granted' || permission === 'denied';
  notifyBtn.textContent =
    permission === 'granted'
      ? 'Avisos activos'
      : permission === 'denied'
        ? 'Avisos bloqueados'
        : 'Activar avisos';
}

function renderConnection(snapshot) {
  const connected = snapshot.connected;
  $('connectionDetail').textContent = connected
    ? `${snapshot.deviceName}${snapshot.deviceId ? ` · ${snapshot.deviceId}` : ''}`
    : snapshot.reconnecting
      ? snapshot.lastEvent || 'Reconectando...'
      : 'Conectá el nodo LM por Bluetooth';
  const badge = connected
    ? ['Conectado', 'ok']
    : snapshot.connecting
      ? ['Conectando', 'info']
      : snapshot.reconnecting
        ? ['Reconectando', 'warn']
        : ['Sin conexión', 'muted'];
  setBadge($('connectionState'), badge[0], badge[1]);
  $('connectBtn').hidden = connected;
  $('connectBtn').disabled = snapshot.connecting;
  $('connectBtn').textContent = snapshot.connecting ? 'Conectando...' : 'Buscar nodo LM';
  $('disconnectBtn2').hidden = !connected;
  $('connectionError').hidden = !snapshot.error;
  $('connectionError').textContent = snapshot.error || '';

  const showGranted =
    !connected && !snapshot.connecting && state.grantedDevices.length > 0;
  $('grantedDevices').hidden = !showGranted;
  const list = $('grantedList');
  clear(list);
  if (!showGranted) {
    return;
  }
  for (const device of state.grantedDevices) {
    const item = document.createElement('div');
    item.className = 'granted-item';
    const name = document.createElement('span');
    name.textContent = device.name || 'Nodo LM';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-small';
    button.textContent = 'Reconectar';
    button.addEventListener('click', async () => {
      await ble.connectDevice(device);
      await loadGrantedDevices();
    });
    item.append(name, button);
    list.append(item);
  }
}

function freshness(snapshot) {
  const nodeAge = snapshot.lastStatusAt ? Date.now() - snapshot.lastStatusAt : Infinity;
  const peersAge = snapshot.lastPeersAt ? Date.now() - snapshot.lastPeersAt : Infinity;
  return {
    nodeAge,
    peersAge,
    nodeStale: Boolean(snapshot.lastStatusAt) && snapshot.connected && nodeAge > NODE_STALE_MS,
    peersStale: Boolean(snapshot.lastPeersAt) && snapshot.connected && peersAge > PEER_STALE_MS,
  };
}

function renderStaleBanner(snapshot) {
  const info = freshness(snapshot);
  const stale = info.nodeStale || info.peersStale;
  $('staleBanner').hidden = !stale;
  if (stale) {
    $('staleText').textContent = info.nodeStale
      ? `Sin estado del nodo hace ${formatAge(info.nodeAge)}. Puede estar ocupado o fuera de alcance.`
      : `Sin snapshot de peers hace ${formatAge(info.peersAge)}. Las posiciones pueden estar desactualizadas.`;
  }
}

function renderFreshness() {
  const snapshot = ble.snapshot();
  renderNode(snapshot);
  renderPeers(snapshot);
  renderNavigation(snapshot);
  renderStaleBanner(snapshot);
}

function renderNode(snapshot) {
  const card = $('nodeCard');
  card.hidden = !snapshot.connected;
  if (!snapshot.connected) {
    return;
  }
  const status = snapshot.status;
  const fresh = freshness(snapshot);
  $('nodeUpdated').textContent = !snapshot.lastStatusAt
    ? 'Esperando status...'
    : fresh.nodeStale
      ? `Sin estado reciente (${formatAge(fresh.nodeAge)})`
      : `Actualizado ${formatClock(snapshot.lastStatusAt)}`;
  setBadge(
    $('fixBadge'),
    fresh.nodeStale ? 'SIN DATOS' : status?.hasFix ? 'FIX' : 'SIN FIX',
    fresh.nodeStale ? 'warn' : status?.hasFix ? 'ok' : status ? 'error' : 'muted',
  );
  const info = $('nodeInfo');
  clear(info);
  if (!status) {
    info.append(infoItem('Estado', 'Esperando status del nodo...'));
    return;
  }
  const rows = [
    ['ID', status.nodeId || '—'],
    ['Origen GPS', sourceName(status.gpsSource)],
    ['Satélites', String(status.satellites)],
    ['Edad fix', formatMs(status.fixAgeMs)],
    ['Peers', String(status.peerCount)],
    ['Uptime', formatUptime(status.uptimeS)],
    ['Secuencia', String(status.seq)],
  ];
  if (status.hasFix) {
    rows.push([
      'Ubicación',
      `${status.lat.toFixed(6)}, ${status.lon.toFixed(6)}`,
    ]);
    rows.push([
      'Precisión',
      `${status.accuracy.toFixed(1)} m · ${status.altitudeM} m`,
    ]);
    if (status.gpsSource !== 2 && state.lastFix) {
      const distance = formatDistance(
        state.lastFix.lat,
        state.lastFix.lon,
        status.lat,
        status.lon,
      );
      const bearing = bearingDegrees(
        state.lastFix.lat,
        state.lastFix.lon,
        status.lat,
        status.lon,
      );
      if (distance) {
        rows.push(['Distancia al nodo', distance]);
      }
      if (Number.isFinite(bearing)) {
        rows.push(['Rumbo al nodo', formatHeading(bearing)]);
      }
    }
  }
  const peers = snapshot.peers || [];
  if (peers.length > 0) {
    const bestRssi = peers.reduce(
      (best, peer) => Math.max(best, Number(peer.rssi) || -127),
      -127,
    );
    rows.push([
      'LoRa',
      `${peers.length} peer${peers.length === 1 ? '' : 's'} · ${bestRssi} dBm`,
    ]);
  }
  for (const [label, value] of rows) {
    info.append(infoItem(label, value));
  }
}

function renderGps() {
  const fix = state.lastFix;
  setBadge(
    $('gpsBadge'),
    state.geoActive ? 'ACTIVO' : 'DETENIDO',
    state.geoActive ? 'ok' : 'muted',
  );
  const button = $('gpsBtn');
  button.textContent = state.geoActive ? 'Detener GPS' : 'Iniciar GPS';
  button.classList.toggle('btn-danger', state.geoActive);
  button.classList.toggle('btn-primary', !state.geoActive);
  const compassButton = $('compassBtn');
  compassButton.textContent = state.compassActive
    ? 'Detener brújula'
    : 'Activar brújula';
  compassButton.classList.toggle('btn-danger', state.compassActive);

  const info = $('gpsInfo');
  clear(info);
  if (fix) {
    info.append(
      infoItem('Posición', `${fix.lat.toFixed(6)}, ${fix.lon.toFixed(6)}`),
      infoItem(
        'Precisión',
        `${Number(fix.accuracy).toFixed(1)} m · ${Math.round(fix.altitude)} m`,
      ),
      infoItem(
        'Edad',
        `${Math.max(0, Math.round((Date.now() - fix.timestamp) / 1000))} s`,
      ),
    );
  } else {
    info.append(infoItem('Posición', 'Sin posición todavía'));
  }
  const headingText = Number.isFinite(state.heading)
    ? `${formatHeading(state.heading)}${state.headingSource === 'gps' ? ' · GPS' : ''}`
    : '—';
  info.append(
    infoItem('Rumbo', headingText),
    infoItem(
      'Brújula',
      state.compassActive
        ? Number.isFinite(state.heading)
          ? 'activa'
          : 'esperando'
        : 'inactiva',
    ),
    infoItem('Enviados', String(state.gpsSentCount)),
    infoItem('Último envío', state.lastGpsSent ? formatClock(state.lastGpsSent) : '—'),
  );
  $('gpsError').hidden = !state.gpsError;
  $('gpsError').textContent = state.gpsError || '';
  $('gpsNote').hidden = !(state.geoActive && !ble.connected);
  renderWakeLock();
}

function wakeLockSupported() {
  return typeof navigator !== 'undefined' && 'wakeLock' in navigator;
}

function wakeLockStatusText() {
  if (!wakeLockSupported()) {
    return 'No soportado en este navegador; usá Auto-Lock > Nunca o la app Flutter.';
  }
  if (!state.wakeLockEnabled) {
    return 'La pantalla puede apagarse normalmente.';
  }
  if (document.hidden) {
    return 'Se reactiva al volver a la app.';
  }
  if (state.wakeLockError) {
    return state.wakeLockError;
  }
  if (state.wakeLockSentinel) {
    return 'Activo: la pantalla no se apagará.';
  }
  return 'Solicitando permiso al navegador...';
}

function renderWakeLock() {
  const toggle = $('wakeLockToggle');
  if (!toggle) {
    return;
  }
  const supported = wakeLockSupported();
  toggle.checked = state.wakeLockEnabled;
  toggle.disabled = !supported;
  const status = $('wakeLockStatus');
  if (status) {
    status.textContent = wakeLockStatusText();
  }
}

async function setWakeLock(enabled) {
  state.wakeLockEnabled = Boolean(enabled);
  state.wakeLockError = null;
  savePreference('lm_wake_lock_v1', state.wakeLockEnabled);
  if (state.wakeLockEnabled) {
    await acquireWakeLock();
  } else {
    await releaseWakeLock();
  }
  renderWakeLock();
}

async function acquireWakeLock() {
  if (!state.wakeLockEnabled || document.hidden || state.wakeLockSentinel) {
    renderWakeLock();
    return;
  }
  if (!wakeLockSupported()) {
    state.wakeLockError = 'No soportado en este navegador.';
    renderWakeLock();
    return;
  }
  try {
    const sentinel = await navigator.wakeLock.request('screen');
    if (!state.wakeLockEnabled) {
      await sentinel.release().catch(() => {});
      return;
    }
    state.wakeLockSentinel = sentinel;
    state.wakeLockError = null;
    sentinel.addEventListener('release', () => {
      if (state.wakeLockSentinel === sentinel) {
        state.wakeLockSentinel = null;
      }
      renderWakeLock();
    });
  } catch (error) {
    state.wakeLockError =
      error?.name === 'NotAllowedError'
        ? 'El navegador bloqueó el Wake Lock.'
        : 'No se pudo mantener la pantalla encendida.';
  }
  renderWakeLock();
}

async function releaseWakeLock() {
  const sentinel = state.wakeLockSentinel;
  state.wakeLockSentinel = null;
  state.wakeLockError = null;
  if (sentinel) {
    try {
      await sentinel.release();
    } catch (_) {}
  }
  renderWakeLock();
}

function onVisibilityChange() {
  if (!state.wakeLockEnabled) {
    renderWakeLock();
    return;
  }
  if (!document.hidden) {
    acquireWakeLock();
  } else {
    renderWakeLock();
  }
}

function renderPeers(snapshot) {
  const peers = snapshot.peers || [];
  const info = freshness(snapshot);
  setBadge($('peersBadge'), String(peers.length), info.peersStale ? 'warn' : 'muted');
  $('peersUpdated').textContent = !snapshot.connected
    ? 'Sin conexión'
    : info.peersStale
      ? `Sin snapshot reciente (${formatAge(info.peersAge)})`
      : snapshot.hubUptimeS
        ? `Red ${formatUptime(snapshot.hubUptimeS)}`
        : 'Sin snapshot';
  const list = $('peersList');
  clear(list);
  if (peers.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'muted small';
    empty.textContent = snapshot.connected
      ? 'Sin peers en la red.'
      : 'Conectá el nodo para ver peers.';
    list.append(empty);
    return;
  }
  const ownHasFix = Boolean(state.lastFix) || Boolean(snapshot.status?.hasFix);
  const ownLat = state.lastFix?.lat ?? snapshot.status?.lat;
  const ownLon = state.lastFix?.lon ?? snapshot.status?.lon;
  for (const peer of peers) {
    const item = document.createElement('div');
    item.className = `peer-item${peer.hasFix ? ' peer-fix' : ''}`;
    const copy = document.createElement('div');
    copy.className = 'peer-copy';
    const title = document.createElement('div');
    title.className = 'peer-title';
    title.textContent = peer.id || '—';
    const sub = document.createElement('p');
    sub.className = 'peer-sub';
    const parts = [
      sourceName(peer.gpsSource),
      `${peer.satellites} sat`,
      `LoRa ${peer.rssi} dBm`,
      `edad ${peer.ageS} s`,
    ];
    if (peer.hasFix && ownHasFix && Number.isFinite(ownLat) && Number.isFinite(ownLon)) {
      const distance = formatDistance(ownLat, ownLon, peer.lat, peer.lon);
      if (distance) {
        parts.push(distance);
      }
      const bearing = bearingDegrees(ownLat, ownLon, peer.lat, peer.lon);
      if (Number.isFinite(bearing)) {
        parts.push(`rumbo ${formatHeading(bearing)}`);
        if (Number.isFinite(state.heading)) {
          parts.push(
            `desvío ${formatRelative(relativeBearing(bearing, state.heading))}`,
          );
        }
      }
    }
    sub.textContent = parts.join(' · ');
    copy.append(title, sub);
    const coords = document.createElement('div');
    coords.className = 'peer-coords';
    coords.textContent = peer.hasFix
      ? `${peer.lat.toFixed(4)}\n${peer.lon.toFixed(4)}`
      : 'sin fix';
    item.append(copy, coords);
    list.append(item);
  }
}

function findNavTarget(snapshot) {
  if (!state.navTarget) {
    return null;
  }
  return (snapshot.peers || []).find((peer) => peer.id === state.navTarget) || null;
}

function formatCoords(point) {
  if (!point || !Number.isFinite(point.lat) || !Number.isFinite(point.lon)) {
    return '—';
  }
  return `${point.lat.toFixed(5)}, ${point.lon.toFixed(5)}`;
}

function formatFixAge(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms)) {
    return '—';
  }
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds === 0 ? 'ahora' : `hace ${seconds} s`;
}

function peerOptionLabel(peer, origin) {
  const parts = [peer.id ? `LM-${peer.id}` : 'LM', sourceName(peer.gpsSource)];
  const route = routeInfo(origin, peer, null);
  if (route.distanceText) {
    parts.push(route.distanceText, route.headingText);
  }
  parts.push(formatFixAge(peer.fixAgeMs));
  return parts.join(' · ');
}

function navRoute(label, origin, target, heading, primary) {
  const route = routeInfo(origin, target, heading);
  const item = document.createElement('div');
  item.className = `nav-route${primary ? ' nav-route-primary' : ''}`;
  const title = document.createElement('strong');
  title.textContent = label;
  const value = document.createElement('span');
  if (!route.distanceText) {
    value.textContent = 'Sin posición';
  } else {
    const parts = [route.distanceText, route.headingText];
    if (Number.isFinite(route.relative)) {
      parts.push(route.relativeText);
    }
    value.textContent = parts.join(' · ');
  }
  item.append(title, value);
  return item;
}

function renderNavigation(snapshot) {
  const peers = (snapshot.peers || []).filter((peer) => peer && peer.id);
  const select = $('navTargetSelect');
  const ids = peers.map((peer) => peer.id);
  if (state.navTarget && !ids.includes(state.navTarget)) {
    ids.unshift(state.navTarget);
  }
  const signature = ids.join('|');
  if (signature !== state.navSignature) {
    state.navSignature = signature;
    clear(select);
    for (const id of ids) {
      const option = document.createElement('option');
      option.value = id;
      select.append(option);
    }
  }
  if (!state.navTarget && peers.length > 0) {
    state.navTarget = peers[0].id;
    savePreference('lm_nav_target_v1', state.navTarget);
  }
  for (const option of Array.from(select.options)) {
    const peer = peers.find((item) => item.id === option.value);
    option.textContent = peer
      ? peerOptionLabel(peer, state.lastFix)
      : `LM-${option.value} · sin datos`;
  }
  select.value = state.navTarget || '';
  select.disabled = ids.length === 0;
  $('showAllNodes').checked = state.showAllNodes;

  const target = findNavTarget(snapshot);
  const node = snapshot.status;
  const nodePosition =
    node?.hasFix && Number.isFinite(node.lat) && Number.isFinite(node.lon) ? node : null;
  const targetPosition =
    target?.hasFix && Number.isFinite(target.lat) && Number.isFinite(target.lon) ? target : null;
  const route = routeInfo(state.lastFix, targetPosition, state.heading);
  const empty = $('navEmpty');
  const info = $('navInfo');
  clear(info);

  if (!target) {
    setBadge($('navBadge'), 'SIN OBJETIVO', 'muted');
    $('navHint').textContent = 'Sin peers en la red.';
    empty.hidden = false;
    empty.textContent = 'Conectá el nodo para ver objetivos disponibles.';
    $('navCompass').classList.add('compass-empty');
    $('navNeedle').style.transform = 'translate(-50%, -100%) rotate(0deg)';
    return;
  }

  empty.hidden = true;
  const label = `LM-${target.id}`;
  $('navHint').textContent = targetPosition
    ? `${label} · ${sourceName(target.gpsSource)}`
    : `${label} · sin fix`;
  if (!targetPosition) {
    setBadge($('navBadge'), 'SIN FIX', 'warn');
  } else if (!route.distanceText) {
    setBadge($('navBadge'), 'SIN GPS', 'warn');
  } else {
    setBadge($('navBadge'), 'LISTO', 'ok');
  }
  info.append(
    navRoute('Tu celular → objetivo', state.lastFix, targetPosition, state.heading, true),
    navRoute(
      node ? `Nodo ${node.nodeId || 'LM'} → objetivo` : 'Nodo → objetivo',
      nodePosition,
      targetPosition,
      null,
      false,
    ),
    infoItem('Tu celular', formatCoords(state.lastFix)),
    infoItem('Objetivo', formatCoords(targetPosition)),
    infoItem('Edad fix objetivo', formatFixAge(target.fixAgeMs)),
  );
  if (!state.lastFix) {
    empty.hidden = false;
    empty.textContent = 'Iniciá el GPS del teléfono para calcular el rumbo exacto al objetivo.';
  } else if (!targetPosition) {
    empty.hidden = false;
    empty.textContent = 'El objetivo no tiene fix de posición.';
  }
  const angle = Number.isFinite(state.heading) ? route.relative : route.bearing;
  $('navCompass').classList.toggle('compass-empty', !Number.isFinite(angle));
  $('navNeedle').style.transform = `translate(-50%, -100%) rotate(${Number.isFinite(angle) ? angle : 0}deg)`;
}

function renderMap(snapshot) {
  const points = [];
  const ids = new Set();
  const status = snapshot.status;
  const target = findNavTarget(snapshot);
  const addPoint = (point) => {
    if (!point || ids.has(point.id)) {
      return;
    }
    ids.add(point.id);
    points.push(point);
  };
  const addPeerPoint = (peer) => {
    if (
      !peer?.hasFix ||
      !Number.isFinite(peer.lat) ||
      !Number.isFinite(peer.lon) ||
      peer.id === status?.nodeId
    ) {
      return;
    }
    addPoint({
      id: `peer:${peer.id}`,
      kind: 'peer',
      lat: peer.lat,
      lon: peer.lon,
      label: peerOptionLabel(peer, state.lastFix),
    });
  };

  if (state.lastFix) {
    addPoint({
      id: 'own',
      kind: 'own',
      lat: state.lastFix.lat,
      lon: state.lastFix.lon,
      label: 'Tu teléfono',
    });
  }
  if (
    status?.hasFix &&
    status.gpsSource !== 2 &&
    Number.isFinite(status.lat) &&
    Number.isFinite(status.lon)
  ) {
    addPoint({
      id: `node:${status.nodeId || 'lm'}`,
      kind: 'node',
      lat: status.lat,
      lon: status.lon,
      label: `Nodo ${status.nodeId || 'LM'} · ${sourceName(status.gpsSource)}`,
    });
  }
  addPeerPoint(target);
  if (state.showAllNodes) {
    for (const peer of snapshot.peers || []) {
      addPeerPoint(peer);
    }
  }

  state.mapPoints = points;
  const mapNode = $('map');
  const empty = $('mapEmpty');
  const hint = $('mapHint');
  const clearObjects = () => {
    for (const marker of state.mapMarkers.values()) {
      marker.remove();
    }
    state.mapMarkers.clear();
    if (state.navLine) {
      state.navLine.remove();
      state.navLine = null;
    }
  };
  if (points.length === 0) {
    clearObjects();
    mapNode.hidden = true;
    empty.hidden = false;
    hint.textContent = 'Activá el GPS del teléfono o conectá un nodo con fix.';
    return;
  }

  mapNode.hidden = false;
  empty.hidden = true;
  const hintParts = [`${points.length} posición${points.length === 1 ? '' : 'es'} en el mapa`];
  const targetPosition =
    target?.hasFix && Number.isFinite(target.lat) && Number.isFinite(target.lon) ? target : null;
  if (targetPosition) {
    hintParts.push(`objetivo LM-${target.id}`);
  }
  if (state.showAllNodes) {
    hintParts.push('todos los nodos');
  }
  hint.textContent = hintParts.join(' · ');
  const map = ensureMap();
  if (!map) {
    clearObjects();
    mapNode.hidden = true;
    empty.hidden = false;
    empty.textContent = 'No se pudo cargar OpenStreetMap.';
    return;
  }

  const seen = new Set();
  for (const point of points) {
    if (seen.has(point.id)) {
      continue;
    }
    seen.add(point.id);
    let marker = state.mapMarkers.get(point.id);
    if (!marker) {
      marker = L.marker([point.lat, point.lon], {
        icon: markerIcon(point.kind),
      }).addTo(map);
      const tooltip = document.createElement('span');
      tooltip.textContent = point.label;
      marker.bindTooltip(tooltip, { direction: 'top', offset: [0, -8] });
      state.mapMarkers.set(point.id, marker);
    } else {
      marker.setLatLng([point.lat, point.lon]);
      if (typeof marker.setTooltipContent === 'function') {
        marker.setTooltipContent(point.label);
      } else {
        marker.bindTooltip(point.label, { direction: 'top', offset: [0, -8] });
      }
    }
  }
  for (const [id, marker] of state.mapMarkers) {
    if (!seen.has(id)) {
      marker.remove();
      state.mapMarkers.delete(id);
    }
  }

  if (state.lastFix && targetPosition) {
    const route = routeInfo(state.lastFix, targetPosition, state.heading);
    const latlngs = [
      [state.lastFix.lat, state.lastFix.lon],
      [targetPosition.lat, targetPosition.lon],
    ];
    if (!state.navLine) {
      state.navLine = L.polyline(latlngs, {
        className: 'nav-line',
        color: '#5aa9ff',
        weight: 3,
        opacity: 0.9,
        dashArray: '7 7',
      }).addTo(map);
    } else {
      state.navLine.setLatLngs(latlngs);
    }
    state.navLine.bindTooltip(`${route.distanceText} · ${route.headingText}`, { sticky: true });
  } else if (state.navLine) {
    state.navLine.remove();
    state.navLine = null;
  }

  map.invalidateSize();
  if (!state.mapHasCentered) {
    centerMap(false);
    state.mapHasCentered = true;
  }
}

function ensureMap() {
  if (state.map) {
    return state.map;
  }
  if (!window.L) {
    return null;
  }
  const map = L.map('map', {
    zoomControl: true,
    attributionControl: true,
    worldCopyJump: true,
  });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(map);
  map.setView([0, 0], 2);
  state.map = map;
  return map;
}

function centerMap(force = false) {
  const map = ensureMap();
  const points = state.mapPoints;
  if (!map || points.length === 0) {
    return;
  }
  if (!force && state.mapHasCentered) {
    return;
  }
  if (points.length === 1) {
    map.setView([points[0].lat, points[0].lon], 15);
    return;
  }
  const bounds = L.latLngBounds(
    points.map((point) => [point.lat, point.lon]),
  );
  map.fitBounds(bounds, { padding: [30, 30], maxZoom: 16 });
}

function markerIcon(kind) {
  return L.divIcon({
    className: 'map-marker',
    html: `<span class="map-pin map-pin-${kind}"></span>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  });
}

function renderEvent(snapshot) {
  $('eventText').textContent = snapshot.lastEvent || 'Listo';
}

function renderChatMeta() {
  const peers = ble.peers.map((peer) => peer.id);
  $('chatMeta').textContent = `${chat.count} mensaje${chat.count === 1 ? '' : 's'}`;
  $('clearChatBtn').disabled = chat.count === 0;
  $('broadcastToggle').checked = state.broadcast;
  $('targetRow').hidden = state.broadcast;
  $('targetHint').hidden = state.broadcast || peers.length > 0;

  const signature = peers.join('|');
  if (signature !== state.peerSignature) {
    state.peerSignature = signature;
    const select = $('targetSelect');
    clear(select);
    for (const id of peers) {
      const option = document.createElement('option');
      option.value = id;
      option.textContent = id;
      select.append(option);
    }
  }
  if (!state.broadcast && !peers.includes(state.target)) {
    state.target = peers[0] ?? null;
  }
  const select = $('targetSelect');
  select.value = state.target ?? '';
  select.disabled = peers.length === 0;

  const input = $('messageInput');
  const bytes = utf8Length(input.value);
  const over = bytes > 180;
  $('byteCounter').textContent = `${bytes} / 180 bytes`;
  $('byteCounter').classList.toggle('error', over);
  $('queueHint').hidden = ble.connected;
  $('sendBtn').disabled =
    !state.nodeIdentity ||
    state.sending ||
    bytes === 0 ||
    over ||
    (!state.broadcast && !state.target);
  $('sendBtn').textContent = state.sending
    ? 'Enviando...'
    : ble.connected
      ? 'Enviar'
      : 'Encolar';
}

function renderTabs() {
  $('monitorTab').classList.toggle('active', state.tab === 'monitor');
  $('mapTab')?.classList.toggle('active', state.tab === 'map');
  $('chatTab').classList.toggle('active', state.tab === 'chat');
  const badge = $('chatBadge');
  if (badge) {
    badge.hidden = state.unread === 0;
    badge.textContent = state.unread > 99 ? '99+' : String(state.unread);
  }
}

function renderMessages() {
  const list = $('chatList');
  const shouldScroll = chat.count > state.renderedChatCount;
  state.renderedChatCount = chat.count;
  clear(list);
  if (chat.count === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = ble.connected
      ? 'Todavía no hay mensajes.\nEscribe el primero en el compositor.'
      : 'Podés escribir ahora: el mensaje se guarda y se envía al reconectar el nodo original.';
    list.append(empty);
    return;
  }
  for (const message of chat.messages) {
    const item = document.createElement('div');
    item.className = `msg ${message.outgoing ? 'msg-outgoing' : 'msg-incoming'}`;
    const meta = document.createElement('div');
    meta.className = 'msg-meta';
    const who = document.createElement('span');
    who.textContent = message.outgoing
      ? `Para ${message.broadcast ? 'todos' : message.to}`
      : `De ${message.from || 'peer'}`;
    const time = document.createElement('span');
    time.textContent = formatTime(message.sentAt);
    meta.append(who, time);
    const text = document.createElement('div');
    text.className = 'msg-text';
    text.textContent = message.text;
    item.append(meta, text);
    if (message.outgoing) {
      const status = document.createElement('div');
      status.className = 'msg-status';
      if (message.status === LM_CHAT_STATUS.delivered) {
        status.classList.add('delivered');
        status.textContent = 'Entregado';
      } else if (message.status === LM_CHAT_STATUS.failed) {
        status.classList.add('failed');
        status.textContent = 'Falló';
      } else if (message.status === LM_CHAT_STATUS.pending) {
        status.classList.add('pending');
        status.textContent = `Pendiente · nodo ${message.from || 'LM'}`;
      } else {
        status.textContent = message.broadcast ? 'Enviado (broadcast)' : 'Enviado';
      }
      item.append(status);
    }
    list.append(item);
  }
  if (shouldScroll) {
    requestAnimationFrame(() => {
      list.lastElementChild?.scrollIntoView({ block: 'end', behavior: 'smooth' });
    });
  }
}

function setTab(tab, updateHash = false) {
  state.tab = tab;
  if (tab === 'chat') {
    state.unread = 0;
  }
  if (updateHash) {
    const hash = tab === 'monitor' ? 'config' : tab;
    if (location.hash !== `#${hash}`) {
      history.replaceState(null, '', `#${hash}`);
    }
  }
  const mapView = $('mapView');
  $('monitorView').hidden = tab !== 'monitor' && (tab !== 'map' || Boolean(mapView));
  if (mapView) {
    mapView.hidden = tab !== 'map';
  }
  $('chatView').hidden = tab !== 'chat';
  renderTabs();
  if (tab === 'chat') {
    renderMessages();
    requestAnimationFrame(() => {
      $('chatList').lastElementChild?.scrollIntoView({ block: 'end' });
    });
  } else {
    requestAnimationFrame(() => {
      state.map?.invalidateSize();
      if (tab === 'map') {
        centerMap(true);
      }
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
    if (tab === 'map' && !mapView) {
      requestAnimationFrame(() => {
        $('mapCard')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }
  }
}

function toggleGps() {
  if (state.geoActive) {
    stopGps();
  } else {
    startGps();
  }
}

async function toggleCompass() {
  if (state.compassActive) {
    stopCompass();
    return;
  }
  await startCompass();
}

async function startCompass() {
  if (typeof window.DeviceOrientationEvent === 'undefined') {
    toast('Este navegador no soporta brújula');
    return;
  }
  if (typeof window.DeviceOrientationEvent.requestPermission === 'function') {
    try {
      const permission = await window.DeviceOrientationEvent.requestPermission();
      if (permission !== 'granted') {
        toast('Permiso de brújula denegado');
        return;
      }
    } catch (_) {
      toast('No se pudo activar la brújula');
      return;
    }
  }
  state.compassActive = true;
  state.headingSource = null;
  window.addEventListener('deviceorientationabsolute', onOrientation, true);
  window.addEventListener('deviceorientation', onOrientation, true);
  renderGps();
}

function stopCompass() {
  state.compassActive = false;
  window.removeEventListener('deviceorientationabsolute', onOrientation, true);
  window.removeEventListener('deviceorientation', onOrientation, true);
  state.heading = null;
  state.headingSource = null;
  const snapshot = ble.snapshot();
  renderGps();
  renderPeers(snapshot);
  renderNavigation(snapshot);
}

function onOrientation(event) {
  let heading = null;
  if (Number.isFinite(event.webkitCompassHeading)) {
    heading = event.webkitCompassHeading;
  } else if (event.absolute && Number.isFinite(event.alpha)) {
    heading = 360 - event.alpha;
  }
  if (!Number.isFinite(heading)) {
    return;
  }
  state.heading = normalizeHeading(heading);
  state.headingSource = 'compass';
  const now = Date.now();
  if (now - state.lastHeadingRender < 120) {
    return;
  }
  state.lastHeadingRender = now;
  const snapshot = ble.snapshot();
  renderGps();
  renderPeers(snapshot);
  renderNavigation(snapshot);
}

function startGps() {
  if (!navigator.geolocation) {
    state.gpsError = 'Este navegador no soporta geolocalización';
    renderGps();
    return;
  }
  if (state.geoWatchId != null) {
    return;
  }
  state.gpsError = null;
  state.geoActive = true;
  renderGps();
  try {
    state.geoWatchId = navigator.geolocation.watchPosition(
      onPosition,
      onGeoError,
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 },
    );
  } catch (error) {
    state.geoActive = false;
    state.gpsError = `GPS: ${error.message || error}`;
    renderGps();
  }
}

function stopGps() {
  if (state.geoWatchId != null) {
    navigator.geolocation.clearWatch(state.geoWatchId);
    state.geoWatchId = null;
  }
  state.geoActive = false;
  renderGps();
}

function onPosition(position) {
  const coords = position.coords;
  const timestamp = Number(position.timestamp) || Date.now();
  state.lastFix = {
    lat: coords.latitude,
    lon: coords.longitude,
    accuracy: Number(coords.accuracy) || 0,
    altitude: Number.isFinite(coords.altitude) ? coords.altitude : 0,
    timestamp,
  };
  if (
    !state.compassActive &&
    Number.isFinite(coords.heading) &&
    coords.heading >= 0
  ) {
    state.heading = normalizeHeading(coords.heading);
    state.headingSource = 'gps';
  }

  if (
    ble.connected &&
    !state.gpsWriteInFlight &&
    Date.now() - state.lastGpsWriteAt >= 1800
  ) {
    state.lastGpsWriteAt = Date.now();
    state.gpsWriteInFlight = true;
    const packet = {
      seq: state.seq,
      lat: state.lastFix.lat,
      lon: state.lastFix.lon,
      accuracy: state.lastFix.accuracy,
      altitudeM: Math.round(state.lastFix.altitude),
      fixAgeMs: Math.min(65535, Math.max(0, Date.now() - timestamp)),
      satellites: 0,
      valid: true,
    };
    state.seq += 1;
    ble
      .writeGps(encodeGpsPacket(packet))
      .then((sent) => {
        if (sent) {
          state.gpsSentCount += 1;
          state.lastGpsSent = Date.now();
        }
      })
      .finally(() => {
        state.gpsWriteInFlight = false;
        renderGps();
      });
  }
  const snapshot = ble.snapshot();
  renderGps();
  renderPeers(snapshot);
  renderNavigation(snapshot);
  renderMap(snapshot);
}

function onGeoError(error) {
  const messages = {
    1: 'Permiso de ubicación denegado',
    2: 'Ubicación no disponible',
    3: 'Tiempo de espera del GPS agotado',
  };
  state.gpsError = messages[error.code] || `GPS: ${error.message || 'error'}`;
  if (error.code === 1) {
    if (state.geoWatchId != null) {
      navigator.geolocation.clearWatch(state.geoWatchId);
      state.geoWatchId = null;
    }
    state.geoActive = false;
  }
  renderGps();
}

async function queueText(text, options) {
  if (state.sending || state.flushing) {
    return false;
  }
  const bytes = utf8Length(text);
  if (bytes === 0) {
    return false;
  }
  if (bytes > 180) {
    toast('El mensaje supera 180 bytes UTF-8');
    return false;
  }
  const identity = ble.status
    ? { id: ble.status.nodeId, bootId: ble.status.bootId }
    : state.nodeIdentity;
  if (!identity) {
    toast('Conectá una vez al nodo para poder enviar');
    return false;
  }
  const { broadcast, target, successMessage, offlineMessage } = options;
  const packet = {
    msgId: randomMsgId(),
    sentAt: nowSeconds(),
    from: identity.id,
    to: target,
    fromBootId: identity.bootId,
    ttl: 0,
    flags: broadcast ? LM_TEXT_FLAG_BROADCAST : 0,
    text,
    broadcast,
  };
  chat.addOutgoing(packet, LM_CHAT_STATUS.pending);
  if (!ble.connected || !ble.status) {
    toast(offlineMessage || 'Mensaje guardado; se enviará al reconectar el nodo original');
    return true;
  }
  state.sending = true;
  renderChatMeta();
  try {
    const sent = await ble.sendText(encodeTextPacket(packet));
    if (sent) {
      chat.setStatus(packet.msgId, LM_CHAT_STATUS.sent);
      toast(successMessage || (broadcast ? 'Broadcast enviado' : `Enviado a ${target}`));
    } else {
      toast('Mensaje guardado para reintentar');
    }
  } finally {
    state.sending = false;
    renderChatMeta();
  }
  return true;
}

async function sendText() {
  const input = $('messageInput');
  const text = input.value.trim();
  if (!text) {
    return;
  }
  if (utf8Length(text) > 180) {
    toast('El mensaje supera 180 bytes UTF-8');
    return;
  }
  const broadcast = state.broadcast;
  const target = broadcast ? '*' : state.target;
  if (!broadcast && !target) {
    toast('No hay peers para enviar 1:1');
    return;
  }
  if (
    !broadcast &&
    ble.connected &&
    !ble.peers.some((peer) => peer.id === target)
  ) {
    toast('El peer ya no está en la red');
    return;
  }
  const queued = await queueText(text, { broadcast, target });
  if (queued) {
    input.value = '';
    state.draft = '';
  }
}

function getSosFix() {
  const fix = state.lastFix;
  if (fix && Date.now() - fix.timestamp <= 60000) {
    return Promise.resolve(fix);
  }
  if (!navigator.geolocation) {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (position) =>
        resolve({
          lat: position.coords.latitude,
          lon: position.coords.longitude,
          accuracy: Number(position.coords.accuracy) || 0,
          altitude: Number.isFinite(position.coords.altitude)
            ? position.coords.altitude
            : 0,
          timestamp: Number(position.timestamp) || Date.now(),
        }),
      () => resolve(null),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 12000 },
    );
  });
}

function formatSosText(fix) {
  const lat = fix.lat.toFixed(5);
  const lon = fix.lon.toFixed(5);
  const accuracy = Math.round(fix.accuracy || 0);
  const altitude = Math.round(fix.altitude || 0);
  return `SOS · ${lat},${lon} · ±${accuracy} m · alt ${altitude} m · ${formatClock(fix.timestamp)}`;
}

async function sendSos() {
  if (state.sosSending || state.sending || state.flushing) {
    return;
  }
  const button = $('sosBtn');
  const label = button?.querySelector('.nav-label');
  state.sosSending = true;
  if (button) {
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
  }
  if (label) {
    label.textContent = '...';
  }
  try {
    const fix = await getSosFix();
    if (!fix) {
      toast('No se pudo obtener tu ubicación para el SOS');
      return;
    }
    await queueText(formatSosText(fix), {
      broadcast: true,
      target: '*',
      successMessage: 'SOS broadcast enviado',
      offlineMessage: 'SOS guardado; se enviará al reconectar',
    });
  } finally {
    state.sosSending = false;
    if (button) {
      button.disabled = false;
      button.removeAttribute('aria-busy');
    }
    if (label) {
      label.textContent = 'SOS';
    }
  }
}

async function installApp() {
  const prompt = state.installPrompt;
  if (!prompt) {
    return;
  }
  state.installPrompt = null;
  prompt.prompt();
  try {
    await prompt.userChoice;
  } catch (_) {}
  renderSupport(ble.snapshot());
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') {
    return;
  }
  navigator.serviceWorker
    .register('./service-worker.js?v=6', { updateViaCache: 'none' })
    .catch(() => {});
}

function infoItem(label, value) {
  const item = document.createElement('div');
  item.className = 'info-item';
  const labelNode = document.createElement('span');
  labelNode.className = 'info-label';
  labelNode.textContent = label;
  const valueNode = document.createElement('span');
  valueNode.className = 'info-value';
  valueNode.textContent = value;
  item.append(labelNode, valueNode);
  return item;
}

function setBadge(element, text, kind) {
  element.textContent = text;
  element.className = `badge badge-${kind}`;
}

function clear(node) {
  while (node.firstChild) {
    node.removeChild(node.firstChild);
  }
}

function formatTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '—';
  }
  return date.toLocaleTimeString('es', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatClock(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '—';
  }
  return date.toLocaleTimeString('es', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatUptime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${rest}s`;
  }
  return `${rest}s`;
}

function packetFromMessage(message) {
  const timestamp = new Date(message.sentAt).getTime();
  return {
    msgId: message.msgId,
    sentAt: Math.floor(timestamp / 1000) || nowSeconds(),
    from: message.from,
    to: message.to,
    fromBootId: message.fromBootId,
    ttl: 0,
    flags: message.broadcast ? LM_TEXT_FLAG_BROADCAST : 0,
    text: message.text,
    broadcast: message.broadcast,
  };
}

function formatAge(ms) {
  if (!Number.isFinite(ms)) {
    return '—';
  }
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds >= 60) {
    return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

function formatMs(value) {
  const ms = Math.max(0, Number(value) || 0);
  if (ms >= 1000) {
    return `${(ms / 1000).toFixed(1)} s`;
  }
  return `${Math.round(ms)} ms`;
}

function loadPreference(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) {
      return fallback;
    }
    return JSON.parse(raw) ?? fallback;
  } catch (_) {
    return fallback;
  }
}

function savePreference(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (_) {}
}

function isStandalone() {
  return (
    window.matchMedia?.('(display-mode: standalone)')?.matches ||
    navigator.standalone === true
  );
}

function toast(message) {
  const node = $('toast');
  node.textContent = message;
  node.hidden = false;
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => {
    node.hidden = true;
  }, 3200);
}

init();
