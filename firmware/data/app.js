(function () {
  "use strict";

  var currentView = "";
  var setupInterval = null;
  var setupDeadline = 0;
  var authBusy = false;
  var stateBusy = false;
  var phoneId = "";
  var phoneLabel = "";
  var currentRequestId = 0;
  var dismissedRequestId = 0;
  var sourceOptionsKey = "";

  var STORAGE_ID_KEY = "lm_phone_id";
  var STORAGE_LABEL_KEY = "lm_phone_label";

  function byId(id) {
    return document.getElementById(id);
  }

  function text(id, value) {
    var el = byId(id);
    if (el) {
      el.textContent = value;
    }
  }

  function valueOr(value, fallback) {
    if (value === undefined || value === null || value === "") {
      return fallback;
    }
    return String(value);
  }

  function show(id, visible) {
    var el = byId(id);
    if (el) {
      el.style.display = visible ? "block" : "none";
    }
  }

  function trim(value) {
    return String(value || "").replace(/^\s+|\s+$/g, "");
  }

  function setStatus(message, isError) {
    var el = byId("status");
    if (!el) {
      return;
    }
    el.textContent = message;
    el.className = isError ? "status status-error" : "status";
  }

  function setError(id, message) {
    var el = byId(id);
    if (!el) {
      return;
    }
    el.textContent = message || "";
    el.style.display = message ? "block" : "none";
  }

  function setMessage(id, message, isError) {
    var el = byId(id);
    if (!el) {
      return;
    }
    el.textContent = message || "";
    el.className = isError ? "error" : "hint";
    el.style.display = message ? "block" : "none";
  }

  function setBusy(buttonId, busy) {
    var el = byId(buttonId);
    if (el) {
      el.disabled = busy;
    }
  }

  function storageGet(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (error) {
      return null;
    }
  }

  function storageSet(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch (error) {
      return false;
    }
    return true;
  }

  function randomHex(byteCount) {
    var out = "";
    var i;
    var value;
    if (window.crypto && window.crypto.getRandomValues && window.Uint8Array) {
      var raw = new Uint8Array(byteCount);
      window.crypto.getRandomValues(raw);
      for (i = 0; i < raw.length; i++) {
        value = raw[i];
        out += (value < 16 ? "0" : "") + value.toString(16);
      }
      return out;
    }
    for (i = 0; i < byteCount; i++) {
      value = Math.floor(Math.random() * 256);
      out += (value < 16 ? "0" : "") + value.toString(16);
    }
    return out;
  }

  function getOrCreatePhoneId() {
    var id = storageGet(STORAGE_ID_KEY);
    if (!id || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) {
      id = randomHex(16);
      storageSet(STORAGE_ID_KEY, id);
    }
    return id;
  }

  function getStoredPhoneLabel() {
    var label = storageGet(STORAGE_LABEL_KEY);
    label = trim(label);
    if (!label) {
      label = "Mi teléfono";
    }
    if (label.length > 40) {
      label = label.substring(0, 40);
    }
    return label;
  }

  function currentPhoneLabel() {
    var input = byId("phone-label");
    var label = input ? trim(input.value) : phoneLabel;
    if (!label) {
      label = phoneLabel || "Mi teléfono";
    }
    if (label.length > 40) {
      label = label.substring(0, 40);
    }
    phoneLabel = label;
    storageSet(STORAGE_LABEL_KEY, label);
    return label;
  }

  function setView(name) {
    if (currentView === name) {
      return;
    }
    currentView = name;
    show("view-setup", name === "setup");
    show("view-login", name === "login");
    show("view-dashboard", name === "dashboard");
    setError("setup-error", "");
    setError("login-error", "");
    setError("dash-error", "");
  }

  function requestJson(method, url, payload, done) {
    var xhr = new XMLHttpRequest();
    var finished = false;

    function finish(err, data) {
      if (finished) {
        return;
      }
      finished = true;
      done(err, data);
    }

    xhr.open(method, url, true);
    xhr.setRequestHeader("Accept", "application/json");
    if (payload !== null) {
      xhr.setRequestHeader("Content-Type", "application/json");
    }
    xhr.timeout = 12000;

    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) {
        return;
      }

      var parsed = null;
      if (xhr.responseText) {
        try {
          parsed = JSON.parse(xhr.responseText);
        } catch (parseError) {
          parsed = null;
        }
      }

      if (xhr.status >= 200 && xhr.status < 300) {
        finish(null, parsed);
        return;
      }

      var message = parsed && parsed.error ? parsed.error : "HTTP " + xhr.status;
      var err = new Error(message);
      err.status = xhr.status;
      err.data = parsed;
      finish(err, null);
    };

    xhr.ontimeout = function () {
      finish(new Error("tiempo de espera agotado"), null);
    };

    xhr.onerror = function () {
      finish(new Error("sin conexión"), null);
    };

    xhr.send(payload === null ? null : JSON.stringify(payload));
  }

  function withClientId(url) {
    return (
      url +
      (url.indexOf("?") >= 0 ? "&" : "?") +
      "client_id=" +
      encodeURIComponent(phoneId)
    );
  }

  function validUsername(username) {
    return /^[A-Za-z0-9._-]{3,32}$/.test(username);
  }

  function validPassword(password) {
    if (password.length < 8 || password.length > 64) {
      return false;
    }
    for (var i = 0; i < password.length; i++) {
      var code = password.charCodeAt(i);
      if (code < 32 || code > 126) {
        return false;
      }
    }
    return true;
  }

  function updateSetupCountdown() {
    var el = byId("setup-countdown");
    if (!el || setupDeadline === 0) {
      return;
    }

    var left = Math.ceil((setupDeadline - Date.now()) / 1000);
    if (left < 0) {
      left = 0;
    }

    if (left > 0) {
      el.textContent =
        "La ventana de setup se cierra en " + left + " segundos.";
      return;
    }

    el.textContent = "La ventana de setup está cerrada.";
    setupDeadline = 0;
    if (setupInterval !== null) {
      clearInterval(setupInterval);
      setupInterval = null;
    }
    show("setup-form", false);
    show("setup-closed", true);
    refresh(true);
  }

  function startSetupCountdown(seconds) {
    setupDeadline = Date.now() + (seconds > 0 ? seconds : 0) * 1000;
    updateSetupCountdown();
    if (setupInterval === null && setupDeadline > 0) {
      setupInterval = setInterval(updateSetupCountdown, 1000);
    }
  }

  function stopSetupCountdown() {
    setupDeadline = 0;
    if (setupInterval !== null) {
      clearInterval(setupInterval);
      setupInterval = null;
    }
  }

  function formatAge(seconds) {
    var value = Number(seconds);
    if (!isFinite(value) || value < 0) {
      value = 0;
    }
    value = Math.floor(value);
    if (value < 60) {
      return "hace " + value + " s";
    }
    if (value < 3600) {
      return "hace " + Math.floor(value / 60) + " min";
    }
    return "hace " + Math.floor(value / 3600) + " h";
  }

  function parseNumber(value) {
    var parsed = parseFloat(value);
    if (!isFinite(parsed)) {
      return null;
    }
    return parsed;
  }

  function toRadians(degrees) {
    return (degrees * Math.PI) / 180;
  }

  function distanceMeters(lat1, lon1, lat2, lon2) {
    var earthRadius = 6371000;
    var dLat = toRadians(lat2 - lat1);
    var dLon = toRadians(lon2 - lon1);
    var a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRadians(lat1)) *
        Math.cos(toRadians(lat2)) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);
    return earthRadius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function bearingDegrees(lat1, lon1, lat2, lon2) {
    var dLon = toRadians(lon2 - lon1);
    var y = Math.sin(dLon) * Math.cos(toRadians(lat2));
    var x =
      Math.cos(toRadians(lat1)) * Math.sin(toRadians(lat2)) -
      Math.sin(toRadians(lat1)) *
        Math.cos(toRadians(lat2)) *
        Math.cos(dLon);
    return (Math.atan2(y, x) * 180) / Math.PI;
  }

  function compassPoint(degrees) {
    var points = ["N", "NE", "E", "SE", "S", "SO", "O", "NO"];
    var index = Math.round(((degrees % 360) + 360) % 360 / 45) % 8;
    return points[index];
  }

  function formatDistance(meters) {
    if (meters < 1000) {
      return Math.round(meters) + " m";
    }
    return (meters / 1000).toFixed(2) + " km";
  }

  function formatBearing(degrees) {
    var value = ((degrees % 360) + 360) % 360;
    return Math.round(value) + "° " + compassPoint(value);
  }

  function parseCoordinate(id, min, max) {
    var el = byId(id);
    if (!el || !trim(el.value)) {
      return null;
    }
    var value = parseNumber(el.value);
    if (value === null || value < min || value > max) {
      return null;
    }
    return value;
  }

  function arrayIndexOf(values, wanted) {
    for (var i = 0; i < values.length; i++) {
      if (values[i] === wanted) {
        return i;
      }
    }
    return -1;
  }

  function parseAccuracy(id) {
    var el = byId(id);
    if (!el || !trim(el.value)) {
      return 0;
    }
    var value = parseNumber(el.value);
    if (value === null || value < 0) {
      return null;
    }
    return value;
  }

  function syncSourceOptions(location, sources) {
    var select = byId("loc-source");
    if (!select) {
      return;
    }

    var focused = document.activeElement === select;
    var previous = select.value;
    var nodes = (sources && sources.nodes) || [];
    var phones = (sources && sources.phones) || [];
    var wanted = valueOr(location && location.selected, "auto");
    var values = ["auto", "manual"];
    var labels = { auto: "Automático", manual: "Manual" };
    var i;

    for (i = 0; i < nodes.length; i++) {
      if (!nodes[i] || !nodes[i].id) {
        continue;
      }
      values.push("node:" + nodes[i].id);
      var nodeLabel = valueOr(nodes[i].label, nodes[i].id);
      if (nodeLabel.indexOf("Nodo ") === 0) {
        nodeLabel = nodeLabel.substring(5);
      }
      labels["node:" + nodes[i].id] = "Nodo: " + nodeLabel;
    }

    for (i = 0; i < phones.length; i++) {
      if (!phones[i] || !phones[i].id) {
        continue;
      }
      values.push("phone:" + phones[i].id);
      labels["phone:" + phones[i].id] =
        "Teléfono: " + valueOr(phones[i].label, phones[i].id);
    }

    if (wanted && arrayIndexOf(values, wanted) === -1) {
      values.push(wanted);
      labels[wanted] = valueOr(
        location && location.selected_label,
        wanted
      );
    }

    var keyParts = [];
    for (i = 0; i < values.length; i++) {
      keyParts.push(values[i] + "=" + labels[values[i]]);
    }
    var nextKey = keyParts.join("|");

    if (nextKey !== sourceOptionsKey) {
      sourceOptionsKey = nextKey;
      select.options.length = 0;
      for (i = 0; i < values.length; i++) {
        var option = document.createElement("option");
        option.value = values[i];
        option.textContent = labels[values[i]];
        select.appendChild(option);
      }
    }

    var target = focused ? previous : wanted;
    if (arrayIndexOf(values, target) === -1) {
      target = wanted;
    }
    select.value = target;
  }

  function renderPhones(sources) {
    var list = byId("phone-list");
    var empty = byId("phones-empty");
    if (!list || !empty) {
      return;
    }

    var phones = (sources && sources.phones) || [];
    while (list.firstChild) {
      list.removeChild(list.firstChild);
    }
    show("phones-empty", phones.length === 0);

    for (var i = 0; i < phones.length; i++) {
      var phone = phones[i];
      if (!phone || !phone.id) {
        continue;
      }

      var item = document.createElement("li");
      item.className = "phone-item";

      var head = document.createElement("div");
      head.className = "phone-head";

      var name = document.createElement("span");
      name.className = "phone-name";
      name.textContent = valueOr(phone.label, phone.id);
      if (phone.selected) {
        name.textContent += " (activo)";
      }
      head.appendChild(name);

      var state = document.createElement("span");
      state.className = "phone-meta";
      if (phone.has_fix) {
        state.textContent = phone.stale
          ? "ubicación obsoleta"
          : "ubicación " + formatAge(phone.age_s);
      } else {
        state.textContent = "sin ubicación";
      }
      head.appendChild(state);
      item.appendChild(head);

      var meta = document.createElement("p");
      meta.className = "phone-meta";
      meta.textContent =
        phone.id + " · visto " + formatAge(phone.last_seen_s);
      item.appendChild(meta);

      var actions = document.createElement("div");
      actions.className = "actions";

      var askButton = document.createElement("button");
      askButton.type = "button";
      askButton.textContent = "Pedir ubicación";
      askButton.onclick = (function (id) {
        return function () {
          requestPhoneLocation("phone:" + id);
        };
      })(phone.id);
      actions.appendChild(askButton);

      var removeButton = document.createElement("button");
      removeButton.type = "button";
      removeButton.className = "danger";
      removeButton.textContent = "Quitar";
      removeButton.onclick = (function (id) {
        return function () {
          clearLocation("phone:" + id);
        };
      })(phone.id);
      actions.appendChild(removeButton);

      item.appendChild(actions);
      list.appendChild(item);
    }
  }

  function renderNodes(sources, location) {
    var list = byId("node-list");
    var empty = byId("nodes-empty");
    if (!list || !empty) {
      return;
    }

    var nodes = (sources && sources.nodes) || [];
    var reference = location && location.fix ? location.fix : null;
    var refLat = reference ? Number(reference.lat) : null;
    var refLon = reference ? Number(reference.lon) : null;
    var hasReference =
      refLat !== null && refLon !== null && isFinite(refLat) && isFinite(refLon);

    while (list.firstChild) {
      list.removeChild(list.firstChild);
    }
    show("nodes-empty", nodes.length === 0);

    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (!node || !node.id) {
        continue;
      }

      var item = document.createElement("li");
      item.className = "phone-item";

      var head = document.createElement("div");
      head.className = "phone-head";

      var name = document.createElement("span");
      name.className = "phone-name";
      var nodeLabel = valueOr(node.label, node.id);
      name.textContent =
        nodeLabel.indexOf("Nodo ") === 0 ? nodeLabel : "Nodo " + nodeLabel;
      if (node.selected) {
        name.textContent += " (activo)";
      }
      head.appendChild(name);

      var state = document.createElement("span");
      state.className = "phone-meta";
      if (node.has_fix) {
        state.textContent = node.stale
          ? "ubicación obsoleta"
          : "ubicación " + formatAge(node.age_s);
      } else {
        state.textContent = "sin ubicación";
      }
      head.appendChild(state);
      item.appendChild(head);

      var meta = document.createElement("p");
      meta.className = "phone-meta";
      var sourcesText = "GPS " + valueOr(node.gps_source, "desconocido");
      if (node.rssi !== undefined && node.rssi !== null) {
        sourcesText += " · RSSI " + node.rssi + " dBm";
      }
      meta.textContent =
        node.id +
        " · visto " +
        formatAge(node.last_seen_s) +
        " · " +
        sourcesText;
      item.appendChild(meta);

      if (hasReference && node.has_fix) {
        var lat = Number(node.lat);
        var lon = Number(node.lon);
        if (isFinite(lat) && isFinite(lon)) {
          var distance = distanceMeters(refLat, refLon, lat, lon);
          var bearing = bearingDegrees(refLat, refLon, lat, lon);
          var relation = document.createElement("p");
          relation.className = "phone-meta";
          relation.textContent =
            "Distancia " +
            formatDistance(distance) +
            " · rumbo " +
            formatBearing(bearing);
          item.appendChild(relation);
        }
      }

      list.appendChild(item);
    }
  }

  function renderLocation(location, sources, request) {
    location = location || {};
    sources = sources || {};
    var fix = location.fix || null;
    var selectedText = valueOr(location.selected_label, location.selected);
    var activeText = "-";
    var coordsText = "-";
    var accuracyText = "-";
    var ageText = "-";
    var warning = "";

    if (fix) {
      activeText = valueOr(location.active_label, location.active);
      if (location.active && activeText !== location.active) {
        activeText += " (" + location.active + ")";
      }

      var lat = Number(fix.lat);
      var lon = Number(fix.lon);
      if (isFinite(lat) && isFinite(lon)) {
        coordsText = lat.toFixed(6) + ", " + lon.toFixed(6);
      }

      var accuracy = Number(fix.accuracy);
      if (isFinite(accuracy) && accuracy > 0) {
        accuracyText = Math.round(accuracy) + " m";
      } else {
        accuracyText = "sin dato";
      }

      ageText = formatAge(location.age_s);
      if (fix.stale) {
        ageText += " (obsoleta)";
        warning =
          "La ubicación tiene más de 60 segundos. Actualízala o elige otra fuente.";
      }
    } else {
      warning =
        location.selected === "auto"
          ? "Todavía no hay una ubicación reciente de ninguna fuente."
          : "La fuente elegida no tiene una ubicación disponible.";
    }

    text("loc-selected", valueOr(selectedText, "-"));
    text("loc-active", activeText);
    text("loc-coords", coordsText);
    text("loc-accuracy", accuracyText);
    text("loc-age", ageText);
    text("loc-warning", warning);
    show("loc-warning", warning.length > 0);

    syncSourceOptions(location, sources);
    renderPhones(sources);
    renderNodes(sources, location);

    if (request && request.id) {
      currentRequestId = request.id;
      text(
        "request-status",
        "Solicitud activa a " +
          (request.target === "auto"
            ? "cualquier teléfono"
            : valueOr(request.target_label, request.target)) +
          "; expira en " +
          valueOr(request.expires_in, 0) +
          " s."
      );
    } else {
      currentRequestId = 0;
      text("request-status", "Sin solicitudes activas.");
    }

    var forMe =
      request &&
      request.for_me &&
      request.id &&
      request.id !== dismissedRequestId;
    show("phone-request", !!forMe);
    if (forMe) {
      text(
        "phone-request-text",
        "El hub pide tu ubicación. La solicitud expira en " +
          valueOr(request.expires_in, 0) +
          " s."
      );
    }
  }

  function renderDashboard(data) {
    var fw = data.fw || {};
    var ap = data.ap || {};

    text("dash-username", valueOr(data.username, "-"));
    text("dash-fw-name", valueOr(fw.name, "-"));
    text("dash-fw-version", valueOr(fw.version, "-"));
    text("dash-fw-role", valueOr(fw.role, "-"));
    text("dash-ap-ssid", valueOr(ap.ssid, "-"));
    text("dash-ap-ip", valueOr(ap.ip, "-"));
    text("dash-configured", data.configured ? "sí" : "no");
    text(
      "dash-uptime",
      valueOr(data.uptime_s, "-") +
        (data.uptime_s !== undefined ? " s" : "")
    );
    text(
      "dash-heap",
      valueOr(data.heap_free, "-") +
        (data.heap_free !== undefined ? " bytes" : "")
    );

    renderLocation(data.location, data.sources, data.request || null);
  }

  function renderState(data) {
    var setup = data.setup || {};
    var configured = !!data.configured;
    var setupOpen = !!setup.open;
    var authenticated = !!data.authenticated;

    if (!configured) {
      setView("setup");
      show("setup-form", setupOpen);
      show("setup-closed", !setupOpen);

      if (setupOpen) {
        startSetupCountdown(setup.expires_in || 0);
        setStatus("Configura el administrador del hub.", false);
      } else {
        stopSetupCountdown();
        text("setup-countdown", "La ventana de setup está cerrada.");
        setStatus("Setup cerrado. Reinicia el hub para reabrirlo.", true);
      }
      return;
    }

    stopSetupCountdown();

    if (!authenticated) {
      setView("login");
      setStatus("Inicia sesión para continuar.", false);
      return;
    }

    setView("dashboard");
    renderDashboard(data);
    setStatus("Sesión activa.", false);
  }

  function refresh(silent) {
    if (stateBusy) {
      return;
    }
    stateBusy = true;
    if (!silent) {
      setStatus("consultando...", false);
    }

    requestJson("GET", withClientId("/api/state"), null, function (err, data) {
      stateBusy = false;
      if (err) {
        setStatus("error: " + err.message, true);
        return;
      }
      renderState(data || {});
    });
  }

  function submitSetup(event) {
    if (event) {
      event.preventDefault();
    }
    if (authBusy) {
      return false;
    }

    var username = trim(byId("setup-username").value);
    var password = byId("setup-password").value;
    var confirm = byId("setup-confirm").value;

    setError("setup-error", "");

    if (!validUsername(username)) {
      setError(
        "setup-error",
        "Usuario inválido: 3-32 letras, números, punto, guion o _."
      );
      return false;
    }
    if (!validPassword(password)) {
      setError(
        "setup-error",
        "Contraseña inválida: 8-64 caracteres imprimibles."
      );
      return false;
    }
    if (password !== confirm) {
      setError("setup-error", "Las contraseñas no coinciden.");
      return false;
    }

    authBusy = true;
    setBusy("setup-submit", true);
    setStatus("Creando administrador...", false);

    requestJson(
      "POST",
      "/api/setup",
      { username: username, password: password },
      function (err) {
        authBusy = false;
        setBusy("setup-submit", false);

        if (err) {
          setError("setup-error", err.message);
          setStatus("No se pudo configurar el hub.", true);
          return;
        }

        byId("setup-password").value = "";
        byId("setup-confirm").value = "";
        refresh(false);
      }
    );

    return false;
  }

  function submitLogin(event) {
    if (event) {
      event.preventDefault();
    }
    if (authBusy) {
      return false;
    }

    var username = trim(byId("login-username").value);
    var password = byId("login-password").value;

    setError("login-error", "");

    if (!username || !password) {
      setError("login-error", "Ingresa usuario y contraseña.");
      return false;
    }

    authBusy = true;
    setBusy("login-submit", true);
    setStatus("Entrando...", false);

    requestJson(
      "POST",
      "/api/login",
      { username: username, password: password },
      function (err) {
        authBusy = false;
        setBusy("login-submit", false);
        byId("login-password").value = "";

        if (err) {
          var message = err.message;
          if (err.status === 429 && err.data && err.data.retry_after) {
            message += " (espera " + err.data.retry_after + " s)";
          }
          setError("login-error", message);
          setStatus("No se pudo iniciar sesión.", true);
          return;
        }

        byId("login-username").value = "";
        refresh(false);
      }
    );

    return false;
  }

  function doLogout() {
    if (authBusy) {
      return;
    }

    authBusy = true;
    setBusy("logout", true);
    setStatus("Cerrando sesión...", false);

    requestJson("POST", "/api/logout", {}, function (err) {
      authBusy = false;
      setBusy("logout", false);

      if (err) {
        setError("dash-error", err.message);
        setStatus("No se pudo cerrar sesión.", true);
        return;
      }

      byId("login-username").value = "";
      byId("login-password").value = "";
      refresh(false);
    });
  }

  function applySource() {
    var select = byId("loc-source");
    if (!select || !select.value) {
      return;
    }

    setError("dash-error", "");
    setBusy("loc-apply", true);
    setStatus("Aplicando fuente...", false);

    requestJson(
      "POST",
      "/api/location/active",
      { source: select.value },
      function (err) {
        setBusy("loc-apply", false);
        if (err) {
          setError("dash-error", err.message);
          setStatus("No se pudo aplicar la fuente.", true);
          return;
        }
        setStatus("Fuente actualizada.", false);
        refresh(true);
      }
    );
  }

  function saveManual() {
    var lat = parseCoordinate("manual-lat", -90, 90);
    var lon = parseCoordinate("manual-lon", -180, 180);
    var accuracy = parseAccuracy("manual-acc");

    setError("dash-error", "");
    if (lat === null || lon === null) {
      setError("dash-error", "Latitud o longitud inválida.");
      return;
    }
    if (accuracy === null) {
      setError("dash-error", "Precisión inválida.");
      return;
    }

    var payload = { lat: lat, lon: lon };
    if (accuracy > 0) {
      payload.accuracy = accuracy;
    }

    setBusy("manual-submit", true);
    setStatus("Guardando ubicación manual...", false);

    requestJson("POST", "/api/location/manual", payload, function (err) {
      setBusy("manual-submit", false);
      if (err) {
        setError("dash-error", err.message);
        setStatus("No se pudo guardar la ubicación.", true);
        return;
      }
      setStatus("Ubicación manual guardada.", false);
      refresh(true);
    });
  }

  function registerPhone() {
    setError("dash-error", "");
    setMessage("phone-message", "", false);
    setBusy("phone-register", true);
    setStatus("Registrando teléfono...", false);

    requestJson(
      "POST",
      "/api/location/phone",
      { client_id: phoneId, label: currentPhoneLabel() },
      function (err) {
        setBusy("phone-register", false);
        if (err) {
          setMessage("phone-message", err.message, true);
          setStatus("No se pudo registrar el teléfono.", true);
          return;
        }
        setMessage("phone-message", "Teléfono registrado.", false);
        setStatus("Teléfono registrado.", false);
        refresh(true);
      }
    );
  }

  function sendPhoneFix(lat, lon, accuracy, method, busyId) {
    var payload = {
      client_id: phoneId,
      label: currentPhoneLabel(),
      lat: lat,
      lon: lon
    };
    if (isFinite(accuracy) && accuracy > 0) {
      payload.accuracy = accuracy;
    }

    setError("dash-error", "");
    setMessage("phone-message", "", false);
    if (busyId) {
      setBusy(busyId, true);
    }
    setStatus("Enviando ubicación...", false);

    requestJson("POST", "/api/location/phone", payload, function (err) {
      if (busyId) {
        setBusy(busyId, false);
      }
      if (err) {
        var message = err.message;
        if (err.status === 429 && err.data && err.data.retry_after) {
          message += " (espera " + err.data.retry_after + " s)";
        }
        setMessage("phone-message", message, true);
        setStatus("No se pudo enviar la ubicación.", true);
        return;
      }
      setMessage(
        "phone-message",
        "Ubicación enviada desde " + method + ".",
        false
      );
      setStatus("Ubicación enviada.", false);
      refresh(true);
    });
  }

  function sendPhoneManual() {
    var lat = parseCoordinate("phone-lat", -90, 90);
    var lon = parseCoordinate("phone-lon", -180, 180);
    var accuracy = parseAccuracy("phone-acc");

    setError("dash-error", "");
    if (lat === null || lon === null) {
      setMessage("phone-message", "Latitud o longitud inválida.", true);
      return;
    }
    if (accuracy === null) {
      setMessage("phone-message", "Precisión inválida.", true);
      return;
    }

    sendPhoneFix(lat, lon, accuracy, "coordenadas manuales", "phone-manual");
  }

  function sendPhoneGps() {
    if (window.isSecureContext === false) {
      setMessage(
        "phone-message",
        "El GPS del teléfono requiere HTTPS. Abrí https://" +
          window.location.hostname +
          "/ e instalá el certificado si hace falta.",
        true
      );
      return;
    }

    if (!navigator.geolocation) {
      setMessage(
        "phone-message",
        "Este navegador no ofrece GPS. Usa las coordenadas manuales.",
        true
      );
      return;
    }

    setMessage("phone-message", "Obteniendo GPS del teléfono...", false);
    setBusy("phone-gps", true);
    setBusy("phone-request-send", true);

    navigator.geolocation.getCurrentPosition(
      function (position) {
        setBusy("phone-gps", false);
        setBusy("phone-request-send", false);
        var accuracy = position.coords.accuracy;
        sendPhoneFix(
          position.coords.latitude,
          position.coords.longitude,
          accuracy,
          "GPS del teléfono",
          "phone-gps"
        );
      },
      function (error) {
        setBusy("phone-gps", false);
        setBusy("phone-request-send", false);
        var reason = "no disponible";
        if (error && error.code === 1) {
          reason = "permiso denegado";
        } else if (error && error.code === 2) {
          reason = "posición no disponible";
        } else if (error && error.code === 3) {
          reason = "tiempo agotado";
        }
        setMessage(
          "phone-message",
          "GPS " +
            reason +
            ". Puedes ingresar latitud y longitud manualmente.",
          true
        );
      },
      {
        enableHighAccuracy: true,
        timeout: 15000,
        maximumAge: 0
      }
    );
  }

  function requestPhoneLocation(target) {
    setError("dash-error", "");
    setStatus("Enviando solicitud...", false);

    requestJson(
      "POST",
      "/api/location/request",
      { target: target },
      function (err) {
        if (err) {
          setError("dash-error", err.message);
          setStatus("No se pudo solicitar la ubicación.", true);
          return;
        }
        setStatus("Solicitud enviada.", false);
        refresh(true);
      }
    );
  }

  function clearLocation(source) {
    setError("dash-error", "");
    setStatus("Borrando ubicación...", false);

    requestJson(
      "POST",
      "/api/location/clear",
      { source: source },
      function (err) {
        if (err) {
          setError("dash-error", err.message);
          setStatus("No se pudo borrar la ubicación.", true);
          return;
        }
        setStatus("Ubicación borrada.", false);
        refresh(true);
      }
    );
  }

  function dismissPhoneRequest() {
    dismissedRequestId = currentRequestId;
    show("phone-request", false);
  }

  function init() {
    phoneId = getOrCreatePhoneId();
    phoneLabel = getStoredPhoneLabel();
    text("phone-id", phoneId);

    var phoneLabelInput = byId("phone-label");
    if (phoneLabelInput) {
      phoneLabelInput.value = phoneLabel;
      phoneLabelInput.addEventListener(
        "change",
        function () {
          currentPhoneLabel();
        },
        false
      );
    }

    var setupForm = byId("setup-form");
    var loginForm = byId("login-form");
    var manualForm = byId("manual-form");
    var refreshButton = byId("refresh");
    var logoutButton = byId("logout");
    var sourceButton = byId("loc-apply");
    var requestAutoButton = byId("request-auto");
    var phoneGpsButton = byId("phone-gps");
    var phoneManualButton = byId("phone-manual");
    var phoneRegisterButton = byId("phone-register");
    var requestSendButton = byId("phone-request-send");
    var requestDismissButton = byId("phone-request-dismiss");

    if (setupForm) {
      setupForm.addEventListener("submit", submitSetup, false);
    }
    if (loginForm) {
      loginForm.addEventListener("submit", submitLogin, false);
    }
    if (manualForm) {
      manualForm.addEventListener(
        "submit",
        function (event) {
          event.preventDefault();
          saveManual();
        },
        false
      );
    }
    if (refreshButton) {
      refreshButton.addEventListener(
        "click",
        function () {
          refresh(false);
        },
        false
      );
    }
    if (logoutButton) {
      logoutButton.addEventListener("click", doLogout, false);
    }
    if (sourceButton) {
      sourceButton.addEventListener("click", applySource, false);
    }
    if (requestAutoButton) {
      requestAutoButton.addEventListener(
        "click",
        function () {
          requestPhoneLocation("auto");
        },
        false
      );
    }
    if (phoneGpsButton) {
      phoneGpsButton.addEventListener("click", sendPhoneGps, false);
    }
    if (phoneManualButton) {
      phoneManualButton.addEventListener("click", sendPhoneManual, false);
    }
    if (phoneRegisterButton) {
      phoneRegisterButton.addEventListener("click", registerPhone, false);
    }
    if (requestSendButton) {
      requestSendButton.addEventListener("click", sendPhoneGps, false);
    }
    if (requestDismissButton) {
      requestDismissButton.addEventListener(
        "click",
        dismissPhoneRequest,
        false
      );
    }

    refresh(false);
    setInterval(function () {
      refresh(true);
    }, 5000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, false);
  } else {
    init();
  }
})();
