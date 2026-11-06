// API Lens injector — runs in the page's MAIN world at document_start.
// Wraps fetch / XMLHttpRequest / sendBeacon and reports request+response
// metadata to the bridge (isolated world) via window.postMessage.
// It records ONLY while the bridge says recording is on for this tab,
// and it never alters page traffic (responses are read from clones).
(function () {
  if (window.__apiLensInstalled) return;
  window.__apiLensInstalled = true;

  var MAX_BODY = 256 * 1024; // 256 KB per body, truncated beyond that
  var recording = false;
  var seq = 0;

  function send(entry) {
    try {
      window.postMessage({ __apiLens: true, kind: "entry", entry: entry }, "*");
    } catch (e) { /* page closing etc. */ }
  }

  window.addEventListener("message", function (e) {
    if (e.source === window && e.data && e.data.__apiLens === true && e.data.kind === "control") {
      recording = !!e.data.recording;
    }
  });
  // Ask the bridge for the current recording state.
  window.postMessage({ __apiLens: true, kind: "ready" }, "*");

  function truncate(s) {
    if (typeof s !== "string") return s;
    return s.length > MAX_BODY ? s.slice(0, MAX_BODY) : s;
  }

  function parseMaybeJson(text) {
    if (typeof text !== "string" || !text) return null;
    var t = text.trim();
    if (t.charAt(0) !== "{" && t.charAt(0) !== "[") return null;
    try { return JSON.parse(t); } catch (e) { return null; }
  }

  function headersToObject(headers) {
    var out = {};
    if (!headers) return out;
    try {
      if (typeof headers.forEach === "function") {
        headers.forEach(function (v, k) { out[k] = v; });
      } else if (Array.isArray(headers)) {
        headers.forEach(function (pair) { out[pair[0]] = pair[1]; });
      } else if (typeof headers === "object") {
        Object.keys(headers).forEach(function (k) { out[k] = String(headers[k]); });
      }
    } catch (e) { /* ignore */ }
    return out;
  }

  function bodyToRaw(body) {
    if (body == null) return null;
    if (typeof body === "string") return truncate(body);
    if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) return truncate(body.toString());
    if (typeof FormData !== "undefined" && body instanceof FormData) {
      var parts = [];
      body.forEach(function (v, k) { parts.push(k + "=" + (typeof v === "string" ? v : "[file]")); });
      return truncate(parts.join("&"));
    }
    return null; // blobs / streams / ArrayBuffers: shape unknown, size only
  }

  function baseEntry(transport, method, url) {
    seq += 1;
    return {
      id: "e" + Date.now().toString(36) + "-" + seq,
      ts: Date.now(),
      pageUrl: window.location.href,
      transport: transport,
      method: (method || "GET").toUpperCase(),
      url: url,
      requestHeaders: {},
      requestBody: null,
      requestBodyRaw: null,
      status: 0,
      responseHeaders: {},
      responseBody: null,
      responseBodyRaw: null,
      durationMs: 0,
      sizeBytes: 0,
    };
  }

  // ---- fetch ----
  var origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function (input, init) {
      var started = performance.now();
      var method = "GET";
      var url = "";
      var reqHeaders = {};
      var reqBodyRaw = null;
      try {
        if (typeof input === "string") { url = input; }
        else if (input && typeof input.url === "string") {
          url = input.url;
          method = input.method || method;
          reqHeaders = headersToObject(input.headers);
        }
        if (init) {
          if (init.method) method = init.method;
          if (init.headers) reqHeaders = headersToObject(init.headers);
          reqBodyRaw = bodyToRaw(init.body);
        }
      } catch (e) { /* fall through with what we have */ }
      var resolvedUrl;
      try { resolvedUrl = new URL(url, window.location.href).href; } catch (e) { resolvedUrl = url; }

      var promise = origFetch.apply(this, arguments);
      if (!recording) return promise;
      return promise.then(function (res) {
        try {
          var entry = baseEntry("fetch", method, resolvedUrl);
          entry.requestHeaders = reqHeaders;
          entry.requestBodyRaw = reqBodyRaw;
          entry.requestBody = parseMaybeJson(reqBodyRaw);
          entry.status = res.status;
          entry.responseHeaders = headersToObject(res.headers);
          entry.durationMs = Math.round(performance.now() - started);
          var clone = res.clone();
          clone.text().then(function (text) {
            entry.responseBodyRaw = truncate(text);
            entry.responseBody = parseMaybeJson(text);
            entry.sizeBytes = text ? text.length : 0;
            entry.truncated = text && text.length > MAX_BODY;
            send(entry);
          }).catch(function () { send(entry); });
        } catch (e) { /* never break the page */ }
        return res;
      }, function (err) {
        try {
          var entry = baseEntry("fetch", method, resolvedUrl);
          entry.requestHeaders = reqHeaders;
          entry.requestBodyRaw = reqBodyRaw;
          entry.requestBody = parseMaybeJson(reqBodyRaw);
          entry.status = 0;
          entry.error = String(err && err.message ? err.message : err);
          entry.durationMs = Math.round(performance.now() - started);
          send(entry);
        } catch (e) { /* ignore */ }
        throw err;
      });
    };
  }

  // ---- XMLHttpRequest ----
  var XHR = window.XMLHttpRequest;
  if (typeof XHR === "function") {
    var proto = XHR.prototype;
    var origOpen = proto.open;
    var origSend = proto.send;
    var origSetHeader = proto.setRequestHeader;
    proto.open = function (method, url) {
      this.__al = { method: (method || "GET").toUpperCase(), url: "" };
      try { this.__al.url = new URL(url, window.location.href).href; } catch (e) { this.__al.url = String(url); }
      return origOpen.apply(this, arguments);
    };
    proto.setRequestHeader = function (name, value) {
      if (this.__al) {
        this.__al.headers = this.__al.headers || {};
        this.__al.headers[name] = value;
      }
      return origSetHeader.apply(this, arguments);
    };
    proto.send = function (body) {
      var xhr = this;
      var meta = xhr.__al || { method: "GET", url: "" };
      var started = performance.now();
      var reqBodyRaw = bodyToRaw(body);
      if (recording) {
        xhr.addEventListener("loadend", function () {
          try {
            var entry = baseEntry("xhr", meta.method, meta.url);
            entry.requestHeaders = meta.headers || {};
            entry.requestBodyRaw = reqBodyRaw;
            entry.requestBody = parseMaybeJson(reqBodyRaw);
            entry.status = xhr.status;
            entry.durationMs = Math.round(performance.now() - started);
            var all = "";
            try { all = xhr.getAllResponseHeaders() || ""; } catch (e) { /* ignore */ }
            all.trim().split(/[\r\n]+/).forEach(function (line) {
              var idx = line.indexOf(":");
              if (idx > 0) entry.responseHeaders[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
            });
            if (xhr.responseType === "" || xhr.responseType === "text") {
              var text = "";
              try { text = xhr.responseText || ""; } catch (e) { /* ignore */ }
              entry.responseBodyRaw = truncate(text);
              entry.responseBody = parseMaybeJson(text);
              entry.sizeBytes = text.length;
              entry.truncated = text.length > MAX_BODY;
            } else if (xhr.responseType === "json" && xhr.response != null) {
              entry.responseBody = xhr.response;
              try { entry.responseBodyRaw = truncate(JSON.stringify(xhr.response)); } catch (e) { /* ignore */ }
            }
            send(entry);
          } catch (e) { /* never break the page */ }
        });
      }
      return origSend.apply(this, arguments);
    };
  }

  // ---- sendBeacon ----
  if (navigator.sendBeacon) {
    var origBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (url, data) {
      if (recording) {
        try {
          var entry = baseEntry("beacon", "POST", new URL(url, window.location.href).href);
          entry.requestBodyRaw = bodyToRaw(data);
          entry.requestBody = parseMaybeJson(entry.requestBodyRaw);
          entry.status = 0; // beacons report no response
          entry.note = "sendBeacon — no response observable";
          send(entry);
        } catch (e) { /* ignore */ }
      }
      return origBeacon(url, data);
    };
  }
})();
