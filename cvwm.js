/*!
 * cvwm - the CDMI Virtual Window Manager: an X11 / FVWM style desktop for CDMI 3 servers, in one plain JavaScript file.
 * cvwm version: 2.100.0
 *
 *   <!doctype html><meta charset="utf-8"><title>cvwm</title><script src="cvwm.js"></script>
 *
 * Serve it from the same origin as the CDMI server, over TLS: the desktop only ever connects to
 * https: URIs, and refuses to start against any other origin. On start it reads the discovery tree the
 * CDMI 3 HTTP binding defines at /.well-known/cdmi/ :
 *
 *   /.well-known/cdmi/cdmi_capabilities/   authentication methods and server capabilities
 *   /.well-known/cdmi/cdmi_namespaces/     a container of references, one per base URI
 *
 * Each reference answers 307 to a base URI. The desktop opens on a sign-in screen; once a principal has signed
 * in, their home (found through the domain's cdmi_domain_userinfo) is mounted as a disk icon at the top right.
 * Discovered namespaces are not mounted automatically -- a home, and any base URI mounted by hand, are the disks.
 * A new home is given an "apps" container that layers the server's published apps (a read-only CDMI import)
 * beneath the home's own, so every account has the applications without a copy.
 * A container that holds "index.js" is an application: opening it runs that script in an iframe,
 * and an "index.png" beside it is the application's icon. Two containers at the root of a disk have a
 * convention: /apps/<name>/ holds the applications cvwm's menus offer and the xterm starts by name, and
 * /bin/<name>/ holds commands the xterm runs (see DEVELOPERS.md). One extended child listing
 * (childfields=objectType;objectName;children) tells both for every child of a container at once.
 * Everything written to the console, every uncaught error and every request, in the desktop and in each
 * application, is also kept in a log that the "console" application shows (cvwm.log).
 * Objects are moved by dragging them onto a container (a window, a container's icon, or a disk), and copied
 * where Ctrl or Alt is held; both are CDMI create operations carrying a "move" or "copy" field.
 * Files dragged from the host computer onto a container window are created there with a CDMI PUT.
 *
 * Options (script attributes or page query string):
 *   data-origin="https://host"    read the discovery tree of another origin (https only; needs cdmi_cors)
 *   ?focus=click                  click-to-focus instead of FVWM's sloppy focus
 */
(function () {
  'use strict';
  if (window.cvwm) return;

  var SCRIPT = document.currentScript;
  var PARAMS = new URLSearchParams(location.search);
  function attr(n) { return SCRIPT ? SCRIPT.getAttribute(n) : null; }

  var CFG = {
    origin: attr('data-origin') || location.origin,
    focus: PARAMS.get('focus') || attr('data-focus') || 'sloppy',
    appEntry: 'index.js',
    appIcon: 'index.png',
    appsDir: 'apps/',
    binDir: 'bin/',
    pageSize: 200,
    maxChildren: 5000,
    probeLimit: 100,
    desksX: 2,
    desksY: 2,
    pagerVisible: true
  };

  var WELL_KNOWN = '/.well-known/cdmi/';
  var HOME_NAME = 'home';       // the discovery-tree reference that names the signed-in principal's home (HOMES.md phase 1)
  var T_CONTAINER = 'application/cdmi-container';
  var T_OBJECT = 'application/cdmi-object';
  var T_QUEUE = 'application/cdmi-queue';
  var T_CAPABILITY = 'application/cdmi-capability';
  var T_DOMAIN = 'application/cdmi-domain';
  var ACCEPT_DIR = T_CONTAINER + ', ' + T_CAPABILITY + ';q=0.9, ' + T_DOMAIN + ';q=0.9';
  /* What a name without a trailing "/" may turn out to be: usually a data object, but also a queue, or (through a
     reference, or a name given without its "/") a container. One request says so, the server choosing among these. */
  var ACCEPT_LEAF = T_OBJECT + ', ' + T_QUEUE + ';q=0.9, ' + T_CONTAINER + ';q=0.8, ' + T_CAPABILITY + ';q=0.7, ' + T_DOMAIN + ';q=0.7';
  /* A value is returned only where a read selects it, so reading an object's value names these fields. */
  var VALUE_FIELDS = '?objectType&objectName&objectID&mimetype&metadata&valuetransferencoding&valuerange&value';
  var MOUNTS_KEY = 'cvwm.mounts', VIEW_KEY = 'cvwm.view';
  var VERSION = '2.100.0';                 // the running build; a change purges cvwm's saved state (see below)
  var VERSION_KEY = 'cvwm.version';

  /* Saved state is namespaced under "cvwm." in localStorage: mounts, the icon/list view choice, known hosts and
     network-access consent. A new build may change the meaning or shape of any of it -- most visibly the mounts,
     where a stale manual mount from an earlier run would otherwise reappear beside the freshly discovered
     namespaces. So on the first run of a new version, drop every "cvwm." key and stamp the new version. This runs
     before any of that state is read. */
  (function purgeOnVersionChange() {
    try {
      if (localStorage.getItem(VERSION_KEY) === VERSION) return;
      for (var i = localStorage.length - 1; i >= 0; i--) {
        var k = localStorage.key(i);
        if (k && k.indexOf('cvwm.') === 0 && k !== VERSION_KEY) localStorage.removeItem(k);
      }
      localStorage.setItem(VERSION_KEY, VERSION);
    } catch (e) { /* storage unavailable: nothing saved, nothing to purge */ }
  })();

  /* ------------------------------------------------------------------ helpers */

  function h(tag, props, kids) {
    var e = document.createElement(tag), k;
    props = props || {};
    for (k in props) {
      if (k === 'class') e.className = props[k];
      else if (k === 'text') e.textContent = props[k];
      else if (k === 'html') e.innerHTML = props[k];            // only ever used with constant SVG strings
      else if (k === 'on') { for (var ev in props.on) e.addEventListener(ev, props.on[ev]); }
      else if (k === 'style') e.style.cssText = props[k];
      else if (props[k] !== null && props[k] !== undefined) e.setAttribute(k, props[k]);
    }
    (kids || []).forEach(function (c) { if (c) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return e;
  }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function stripQuery(u) { return String(u).replace(/[?#].*$/, ''); }
  function enc(name) { return encodeURIComponent(name); }
  function safeDecode(s) { try { return decodeURIComponent(s); } catch (e) { return s; } }

  function CdmiError(status, message, url) {
    this.name = 'CdmiError'; this.status = status; this.message = message; this.url = url;
  }
  CdmiError.prototype = Object.create(Error.prototype);


  /* ------------------------------------------------------------------ the log behind the console application

     A page cannot read the browser's console, but it can see most of what goes into it: calls to console.*,
     uncaught errors, unhandled rejections, resources that failed to load, policy violations, and its own
     requests. capture() listens for those in one window - the desktop's, and each application's iframe before
     the application's script runs - and adds them to one list, kept from the moment the page loads.
     What the browser writes by itself (the reason a CORS or mixed-content request was blocked, anything inside
     a frame of another origin) never reaches a script, so it is not here either. */

  var LOG = { list: [], max: 3000, seq: 0, subs: [] };

  function describeValue(v, depth) {
    depth = depth || 0;
    try {
      if (typeof v === 'string') return depth ? JSON.stringify(v) : v;
      if (v === null || v === undefined || typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
      if (typeof v === 'symbol') return v.toString();
      if (typeof v === 'function') return 'function ' + (v.name || '(anonymous)') + '()';
      if (typeof v.message === 'string' && typeof v.name === 'string' && 'stack' in v) return v.name + ': ' + v.message;        // an Error from any window
      if (typeof v.nodeType === 'number' && typeof v.nodeName === 'string') return '<' + v.nodeName.toLowerCase() + (v.id ? '#' + v.id : '') + (v.className && typeof v.className === 'string' ? '.' + v.className.trim().replace(/\s+/g, '.') : '') + '>';
      if (depth > 2) return Array.isArray(v) ? '[\u2026]' : '{\u2026}';
      if (typeof v.length === 'number' && typeof v !== 'function' && (Array.isArray(v) || ArrayBuffer.isView(v))) {
        var items = Array.prototype.slice.call(v, 0, 50).map(function (x) { return describeValue(x, depth + 1); });
        if (v.length > 50) items.push('\u2026 ' + (v.length - 50) + ' more');
        return '[' + items.join(', ') + ']';
      }
      var keys = Object.keys(v), name = v.constructor && v.constructor.name && v.constructor.name !== 'Object' ? v.constructor.name + ' ' : '';
      var parts = keys.slice(0, 30).map(function (k) { var x; try { x = describeValue(v[k], depth + 1); } catch (e) { x = '(unreadable)'; } return k + ': ' + x; });
      if (keys.length > 30) parts.push('\u2026 ' + (keys.length - 30) + ' more');
      return name + '{' + parts.join(', ') + '}';
    } catch (e) { return '(unprintable value)'; }
  }
  function describeArgs(args) {
    var text = Array.prototype.map.call(args, function (a) { return describeValue(a); }).join(' ');
    return text.length > 20000 ? text.slice(0, 20000) + ' \u2026' : text;
  }
  function stackOf(args) { for (var i = 0; i < args.length; i++) { var a = args[i]; try { if (a && typeof a.stack === 'string' && typeof a.message === 'string') return a.stack; } catch (e) { /* another origin */ } } return null; }

  /* level: error | warn | info | log | debug.  kind: console | error | net | eval | note. */
  function logAdd(level, kind, source, text, stack) {
    var entry = { n: ++LOG.seq, time: Date.now(), level: level, kind: kind, source: typeof source === 'function' ? source() : source, text: String(text), stack: stack || null };
    LOG.list.push(entry); if (LOG.list.length > LOG.max) LOG.list.splice(0, LOG.list.length - LOG.max);
    LOG.subs.slice().forEach(function (fn) { try { fn(entry); } catch (e) { /* a subscriber's trouble is not ours, and logging it here would loop */ } });
    return entry;
  }

  function loggedFetch(source, inner) {
    return function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || String(input), method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      var quiet = !!(init && init.fvQuiet), t0 = performance.now();
      if (init && 'fvQuiet' in init) { init = Object.assign({}, init); delete init.fvQuiet; }
      var p;
      try { p = Promise.resolve(inner(input, init)); } catch (e) { p = Promise.reject(e); }
      return p.then(function (res) {
        var ms = Math.round(performance.now() - t0), bad = !res.ok;
        logAdd(bad ? (quiet ? 'debug' : 'warn') : 'debug', 'net', source, method + ' ' + url + ' \u2192 ' + res.status + (res.statusText ? ' ' + res.statusText : '') +
          (res.redirected || (res.url && stripQuery(res.url) !== stripQuery(new URL(url, location.href).href)) ? '  (landed on ' + res.url + ')' : '') + '  ' + ms + ' ms' + (bad && quiet ? '  (a probe; this was expected)' : ''));
        return res;
      }, function (e) {
        var hint = '';
        try {
          var u = new URL(url, location.href);
          if (e && e.name === 'AbortError') hint = '';
          else if (location.protocol === 'https:' && u.protocol === 'http:') hint = '  Likely cause: mixed content - an http: URI requested from an https: page.';
          else if (u.origin !== location.origin) hint = '  Likely cause: the other origin did not allow this one (CORS), or it could not be reached. The browser console has the reason.';
          else hint = '  The server could not be reached, or it redirected to somewhere the browser would not follow (an http: URI, or another origin).';
        } catch (x) { /* not a URL */ }
        logAdd(e && e.name === 'AbortError' ? 'info' : 'error', 'net', source, method + ' ' + url + ' failed: ' + (e && e.message || e) + hint);
        throw e;
      });
    };
  }

  function capture(win, source, wrapFetch) {
    if (win.__cdmiCaptured) return; win.__cdmiCaptured = true;
    var con = win.console;
    ['error', 'warn', 'info', 'log', 'debug'].forEach(function (m) {
      var original = con[m]; if (typeof original !== 'function') return;
      con[m] = function () { try { logAdd(m, 'console', source, describeArgs(arguments), stackOf(arguments)); } catch (e) { /* never break the caller */ } return original.apply(con, arguments); };
    });
    var assert = con.assert;
    if (typeof assert === 'function') con.assert = function (ok) { if (!ok) { try { logAdd('error', 'console', source, 'Assertion failed: ' + describeArgs(Array.prototype.slice.call(arguments, 1))); } catch (e) { /* ignore */ } } return assert.apply(con, arguments); };
    win.addEventListener('error', function (ev) {
      var t = ev.target;
      if (t && t !== win && t.nodeName) { logAdd('error', 'error', source, 'Failed to load <' + t.nodeName.toLowerCase() + '> ' + (t.src || t.href || t.data || '(no address)')); return; }   // a resource
      logAdd('error', 'error', source, 'Uncaught ' + (ev.error ? describeValue(ev.error) : ev.message) + (ev.filename ? '  (' + ev.filename + ':' + ev.lineno + ':' + ev.colno + ')' : ''), ev.error && ev.error.stack);
    }, true);
    win.addEventListener('unhandledrejection', function (ev) { logAdd('error', 'error', source, 'Unhandled promise rejection: ' + describeValue(ev.reason), ev.reason && ev.reason.stack); });
    win.document.addEventListener('securitypolicyviolation', function (ev) { logAdd('error', 'error', source, 'Content Security Policy: ' + ev.violatedDirective + ' blocked ' + (ev.blockedURI || 'inline code')); });
    if (win.ReportingObserver) { try { new win.ReportingObserver(function (reports) { reports.forEach(function (r) { logAdd('warn', 'note', source, '[' + r.type + '] ' + ((r.body && r.body.message) || describeValue(r.body))); }); }, { buffered: true }).observe(); } catch (e) { /* not supported after all */ } }
    if (wrapFetch && typeof win.fetch === 'function') win.fetch = loggedFetch(source, win.fetch.bind(win));
  }
  capture(window, 'desktop', false);            // the desktop's own requests are logged at CD.fetch, below


  /* ------------------------------------------------------------------ net: TCP connections through the relay

     A page cannot open TCP. RELAY.md specifies a WebSocket-to-TCP relay in seedmi; this is its client, so that an
     application or a command asks for a socket and never sees the relay: net.connect() finds the relay in the disk's
     capabilities, asks the user's leave, gets a ticket with the user's credentials, opens the WebSocket, presents
     the ticket, and hands back a Socket - a byte stream with backpressure, keepalive, and a place in the log.
     net.reader() turns a Socket into read(n)/readLine() for protocols with framing. */
  var NET = { consent: {}, seq: 0 }, CONSENT_KEY = 'cvwm.net.consent';
  try { NET.consent = JSON.parse(localStorage.getItem(CONSENT_KEY) || '{}'); } catch (e) { /* no storage */ }
  function NetError(code, message) { this.name = 'NetError'; this.code = code; this.message = message; }
  NetError.prototype = Object.create(Error.prototype);

  /* A pipe (RELAY.md draft 2): a queue object whose cdmi_queue_type is seedmi_pipe. An application that needs the
     network keeps one in its own directory; net.connect() makes it there the first time, and a pipe that already
     exists elsewhere may be named instead. Making one confers nothing: the server's permits say where it may lead. */
  var PIPE_TYPE = 'seedmi_pipe', PIPE_TICKET = 'application/vnd.seedmi.pipe-ticket+json', PIPE_PROTO = 'seedmi-pipe.v1', WS_CHUNK = 65536;
  async function ensurePipe(uri) {
    var res = await req(uri + '?objectType&metadata=cdmi_queue_type', T_QUEUE, { quiet: true, probe: true });
    if (res.ok) { var rep = await res.json(); if (((rep.metadata || {}).cdmi_queue_type) !== PIPE_TYPE) throw new NetError(4400, uri + ' is a queue but not a pipe'); return uri; }
    if (res.status !== 404) throw new NetError(res.status === 401 ? 4401 : 4403, (await toError(res)).message);
    var made = await send('PUT', uri, T_QUEUE, JSON.stringify({ metadata: { cdmi_queue_type: PIPE_TYPE } }), { 'If-None-Match': '*' });
    if (!made.ok && made.status !== 412) throw new NetError(4403, 'cannot make a pipe at ' + uri + ': ' + (await toError(made)).message);
    logAdd('info', 'net', 'desktop', 'made a pipe at ' + uri);
    return uri;
  }

  /* The user's leave: once per application and destination, or always. */
  async function netConsent(label, host, port) {
    var key = label + '|' + host + ':' + port;
    try { NET.consent = JSON.parse(localStorage.getItem(CONSENT_KEY) || '{}'); } catch (e) { /* as loaded */ }
    if (NET.consent[key] === 'always') return true;
    var choice = await chooseBox('Connect?', label + ' wants to connect to ' + host + ' port ' + port + ' through the relay.', ['Deny', 'Allow once', 'Always for this application']);
    if (choice === 2) { NET.consent[key] = 'always'; try { localStorage.setItem(CONSENT_KEY, JSON.stringify(NET.consent)); } catch (e) { /* kept for this page */ } }
    return choice > 0;
  }

  function Socket(ws, remote, label) {
    var self = this, dataFns = [], closeFns = [], closed = false, pings = 0, t0 = Date.now();
    this.remote = remote; this.stats = { sent: 0, received: 0, opened: t0 };
    ws.onmessage = function (ev) {
      if (typeof ev.data === 'string') { var m = null; try { m = JSON.parse(ev.data); } catch (e) { /* not control */ } if (m && m.ping !== undefined) ws.send(JSON.stringify({ pong: m.ping })); return; }
      var bytes = new Uint8Array(ev.data); self.stats.received += bytes.length; dataFns.forEach(function (f) { try { f(bytes); } catch (e) { console.error(e); } });
    };
    ws.onclose = function (ev) {
      if (closed) return; closed = true; clearInterval(keep);
      logAdd(ev.code === 1000 || ev.code === 1005 ? 'debug' : 'warn', 'net', label, 'closed ' + remote + ': ' + ev.code + (ev.reason ? ' ' + ev.reason : '') + '  ' + self.stats.sent + ' B out, ' + self.stats.received + ' B in, ' + Math.round((Date.now() - t0) / 1000) + ' s');
      closeFns.forEach(function (f) { try { f(ev.code, ev.reason); } catch (e) { console.error(e); } });
    };
    ws.onerror = function () { /* onclose follows with the code */ };
    var keep = setInterval(function () { if (ws.readyState === 1) ws.send(JSON.stringify({ ping: ++pings })); }, 30000);
    this.write = function (bytes) {              // resolves once the buffer has drained below the threshold: backpressure as an await
      if (closed) return Promise.reject(new NetError(0, 'the connection is closed'));
      if (typeof bytes === 'string') bytes = new TextEncoder().encode(bytes);
      for (var at = 0; at < bytes.length; at += WS_CHUNK) ws.send(bytes.subarray(at, at + WS_CHUNK));       // no frame beyond the size both sides know
      self.stats.sent += bytes.length;
      return new Promise(function (resolve) { (function wait() { if (closed || ws.bufferedAmount < 1048576) resolve(); else setTimeout(wait, 20); })(); });
    };
    this.onData = function (f) { dataFns.push(f); return self; };
    this.onClose = function (f) { closeFns.push(f); if (closed) f(1000, 'closed'); return self; };
    this.close = function () { if (!closed) ws.close(1000, 'client-closed'); };
    Object.defineProperty(this, 'open', { get: function () { return !closed; } });
  }

  async function netConnect(label, host, port, opts) {
    opts = opts || {};
    host = String(host || '').trim().toLowerCase(); port = port | 0;
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(host) || /^[0-9.]+$/.test(host)) throw new NetError(4400, 'not a host name: ' + JSON.stringify(host) + ' (the pipe takes names, not addresses)');
    if (port < 1 || port > 65535) throw new NetError(4400, 'not a port: ' + port);
    var pipe = opts.pipe || (opts.containerURI ? opts.containerURI + 'pipe' : null);
    if (!pipe) throw new NetError(4404, 'no pipe: the caller named none and has no container of its own');
    requireTLS(pipe); pipe = await ensurePipe(stripQuery(pipe));
    if (!(await netConsent(label, host, port))) throw new NetError(4403, 'the user did not allow it');
    var res = await send('POST', pipe, PIPE_TICKET, JSON.stringify({ host: host, port: port }));
    if (!res.ok) { var e = await toError(res); throw new NetError(res.status === 401 ? 4401 : res.status === 403 ? 4403 : res.status === 429 ? 4429 : 4400, res.status === 403 ? 'not permitted through this pipe (the server\'s log says why)' : e.message); }
    var ticket = await res.json(), remote = host + ':' + port;
    logAdd('debug', 'net', label, 'ticket for ' + remote + ' through ' + pipe);
    return new Promise(function (resolve, reject) {
      var url = pipe.replace(/^https:/, 'wss:'), ws = new WebSocket(url, [PIPE_PROTO]), settled = false;
      ws.binaryType = 'arraybuffer';
      var timer = setTimeout(function () { if (!settled) { settled = true; ws.close(); reject(new NetError(4408, 'the pipe did not answer')); } }, 15000);
      ws.onopen = function () { ws.send(JSON.stringify({ v: 1, ticket: ticket.ticket })); };
      ws.onmessage = function (ev) {
        var m = null; try { m = JSON.parse(ev.data); } catch (x) { /* not the answer */ }
        if (settled) return; settled = true; clearTimeout(timer);
        if (m && m.ok) { logAdd('info', 'net', label, 'connected to ' + remote); resolve(new Socket(ws, remote, label)); }
        else { ws.close(); reject(new NetError(4400, (m && m.error) || 'the pipe refused')); }
      };
      ws.onclose = function (ev) { if (!settled) { settled = true; clearTimeout(timer); reject(new NetError(ev.code, closeText(ev.code, ev.reason))); } };
      ws.onerror = function () { /* onclose follows */ };
    });
  }
  function closeText(code, reason) { return { 4400: 'malformed', 4401: 'the ticket was not accepted', 4403: 'no longer permitted', 4408: 'the destination cannot be reached', 4429: 'too many connections', 1009: 'a frame was too large' }[code] || (reason || 'the pipe closed the connection (' + code + ')'); }

  /* A reader over a Socket: bytes are queued as they arrive, and read(n) resolves when n have. */
  function Reader(socket) {
    var chunks = [], have = 0, waiting = [], closed = null;
    function pump() { while (waiting.length) { var w = waiting[0], got = w.take(); if (got === undefined) { if (closed) { waiting.shift(); w.reject(new NetError(closed.code, 'the connection closed' + (closed.reason ? ': ' + closed.reason : ''))); continue; } return; } waiting.shift(); w.resolve(got); } }
    function take(n) { if (have < n) return undefined; var out = new Uint8Array(n), at = 0; while (at < n) { var c = chunks[0], need = n - at; if (c.length <= need) { out.set(c, at); at += c.length; chunks.shift(); } else { out.set(c.subarray(0, need), at); chunks[0] = c.subarray(need); at += need; } } have -= n; return out; }
    function indexOf(byte) { var off = 0; for (var i = 0; i < chunks.length; i++) { var j = chunks[i].indexOf(byte); if (j >= 0) return off + j; off += chunks[i].length; } return -1; }
    socket.onData(function (b) { chunks.push(b); have += b.length; pump(); });
    socket.onClose(function (code, reason) { closed = { code: code, reason: reason }; pump(); });
    this.read = function (n) { return new Promise(function (resolve, reject) { waiting.push({ take: function () { return take(n); }, resolve: resolve, reject: reject }); pump(); }); };
    this.readUntil = function (byte, keep) { return new Promise(function (resolve, reject) { waiting.push({ take: function () { var i = indexOf(byte); if (i < 0) return undefined; var got = take(i + 1); return keep ? got : got.subarray(0, i); }, resolve: resolve, reject: reject }); pump(); }); };
    this.readLine = async function () { var b = await this.readUntil(10); if (b.length && b[b.length - 1] === 13) b = b.subarray(0, b.length - 1); return new TextDecoder().decode(b); };
    this.unread = function (bytes) { chunks.unshift(bytes); have += bytes.length; };
    this.available = function () { return have; };
  }
  var bytesLib = {
    concat: function () { var n = 0, i; for (i = 0; i < arguments.length; i++) n += arguments[i].length; var out = new Uint8Array(n), at = 0; for (i = 0; i < arguments.length; i++) { out.set(arguments[i], at); at += arguments[i].length; } return out; },
    u32: function (n) { return new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]); },
    readU32: function (b, at) { at = at || 0; return ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0; },
    encode: function (s) { return new TextEncoder().encode(s); }, decode: function (b) { return new TextDecoder().decode(b); },
    hex: function (b) { return Array.prototype.map.call(b, function (x) { return (x < 16 ? '0' : '') + x.toString(16); }).join(''); },
    random: function (n) { var b = new Uint8Array(n); crypto.getRandomValues(b); return b; }
  };

  /* ------------------------------------------------------------------ net.crypto: what a protocol needs of WebCrypto

     Over WebCrypto, taking and returning Uint8Arrays, so that a protocol's code reads as the RFC does. Where a browser
     lacks a primitive (X25519 and Ed25519 are still uneven), a JavaScript one over BigInt stands in: X25519 as in
     RFC 7748 section 5, Ed25519 as in RFC 8032 section 5.1. Both are checked against the RFCs' vectors by /bin/cryptotest,
     and crypto.has says which the browser supplied. Everything here is async because WebCrypto is. */
  var subtle = window.crypto && window.crypto.subtle;

  /* ChaCha20 and Poly1305, both in JavaScript (WebCrypto has neither), from RFC 8439 and the SSH draft. */
  function rotl(x, n) { return ((x << n) | (x >>> (32 - n))) >>> 0; }
  function chachaBlock(key32, counterLo, counterHi, nonce8, out) {
    var x = new Uint32Array(16); x[0] = 0x61707865; x[1] = 0x3320646e; x[2] = 0x79622d32; x[3] = 0x6b206574;
    for (var i = 0; i < 8; i++) x[4 + i] = (key32[i * 4] | (key32[i * 4 + 1] << 8) | (key32[i * 4 + 2] << 16) | (key32[i * 4 + 3] << 24)) >>> 0;
    x[12] = counterLo >>> 0; x[13] = counterHi >>> 0;
    x[14] = (nonce8[0] | (nonce8[1] << 8) | (nonce8[2] << 16) | (nonce8[3] << 24)) >>> 0; x[15] = (nonce8[4] | (nonce8[5] << 8) | (nonce8[6] << 16) | (nonce8[7] << 24)) >>> 0;
    var w = x.slice();
    function qr(a, b, cc, d) { w[a] = (w[a] + w[b]) >>> 0; w[d] = rotl(w[d] ^ w[a], 16); w[cc] = (w[cc] + w[d]) >>> 0; w[b] = rotl(w[b] ^ w[cc], 12); w[a] = (w[a] + w[b]) >>> 0; w[d] = rotl(w[d] ^ w[a], 8); w[cc] = (w[cc] + w[d]) >>> 0; w[b] = rotl(w[b] ^ w[cc], 7); }
    for (var r = 0; r < 10; r++) { qr(0, 4, 8, 12); qr(1, 5, 9, 13); qr(2, 6, 10, 14); qr(3, 7, 11, 15); qr(0, 5, 10, 15); qr(1, 6, 11, 12); qr(2, 7, 8, 13); qr(3, 4, 9, 14); }
    for (i = 0; i < 16; i++) { var v = (w[i] + x[i]) >>> 0; out[i * 4] = v & 255; out[i * 4 + 1] = (v >>> 8) & 255; out[i * 4 + 2] = (v >>> 16) & 255; out[i * 4 + 3] = (v >>> 24) & 255; }
  }
  function chacha20(key32, counter, nonce8, data) {           // counter: starting 64-bit block counter (a Number, small)
    var out = new Uint8Array(data.length), block = new Uint8Array(64), lo = counter >>> 0, hi = Math.floor(counter / 4294967296) >>> 0;
    for (var off = 0; off < data.length; off += 64) {
      chachaBlock(key32, lo, hi, nonce8, block); lo = (lo + 1) >>> 0; if (lo === 0) hi = (hi + 1) >>> 0;
      for (var i = 0; i < 64 && off + i < data.length; i++) out[off + i] = data[off + i] ^ block[i];
    }
    return out;
  }
  function poly1305(key32, msg) {                             // key32: 32 bytes; r = first 16 clamped, s = last 16
    var P = (1n << 130n) - 5n, rb = key32.subarray(0, 16), sb = key32.subarray(16, 32);
    var r = bnFromLE(rb) & 0x0ffffffc0ffffffc0ffffffc0fffffffn, s = bnFromLE(sb), a = 0n;
    for (var off = 0; off < msg.length; off += 16) {
      var block = msg.subarray(off, off + 16), n = bnFromLE(block) + (1n << BigInt(8 * block.length));
      a = (a + n) * r % P;
    }
    a = (a + s) & ((1n << 128n) - 1n);
    return bnToLE(a, 16);
  }

  function bnFromLE(b) { var x = 0n; for (var i = b.length - 1; i >= 0; i--) x = (x << 8n) | BigInt(b[i]); return x; }
  function bnToLE(x, n) { var out = new Uint8Array(n); for (var i = 0; i < n; i++) { out[i] = Number(x & 255n); x >>= 8n; } return out; }
  function bnFromBE(b) { var x = 0n; for (var i = 0; i < b.length; i++) x = (x << 8n) | BigInt(b[i]); return x; }
  function bnToBE(x, n) { var out = new Uint8Array(n); for (var i = n - 1; i >= 0; i--) { out[i] = Number(x & 255n); x >>= 8n; } return out; }
  function modPow(b, e, m) { var r = 1n; b %= m; while (e > 0n) { if (e & 1n) r = r * b % m; e >>= 1n; b = b * b % m; } return r; }
  function mod(a, m) { var r = a % m; return r < 0n ? r + m : r; }

  /* X25519, RFC 7748 section 5: the Montgomery ladder on the u-coordinate, constant-time in structure. */
  var P25519 = (1n << 255n) - 19n, A24 = 121665n;
  function x25519JS(k, u) {
    k = k.slice(); k[0] &= 248; k[31] &= 127; k[31] |= 64;                       // decodeScalar25519
    var kn = bnFromLE(k), un = bnFromLE(u) & ((1n << 255n) - 1n), p = P25519;
    var x1 = un, x2 = 1n, z2 = 0n, x3 = un, z3 = 1n, swap = 0n;
    for (var t = 254; t >= 0; t--) {
      var kt = (kn >> BigInt(t)) & 1n; swap ^= kt;
      if (swap) { var tmp = x2; x2 = x3; x3 = tmp; tmp = z2; z2 = z3; z3 = tmp; } swap = kt;
      var A = mod(x2 + z2, p), AA = A * A % p, B = mod(x2 - z2, p), BB = B * B % p, E = mod(AA - BB, p), C = mod(x3 + z3, p), D = mod(x3 - z3, p), DA = D * A % p, CB = C * B % p;
      x3 = mod((DA + CB) * (DA + CB), p); z3 = x1 * mod((DA - CB) * (DA - CB), p) % p; x2 = AA * BB % p; z2 = E * mod(AA + A24 * E, p) % p;
    }
    if (swap) { tmp = x2; x2 = x3; x3 = tmp; tmp = z2; z2 = z3; z3 = tmp; }
    return bnToLE(x2 * modPow(z2, p - 2n, p) % p, 32);
  }

  /* Ed25519, RFC 8032 section 5.1, in extended coordinates. */
  var ED = { p: P25519, L: (1n << 252n) + 27742317777372353535851937790883648493n, d: mod(-121665n * modPow(121666n, P25519 - 2n, P25519), P25519) };
  ED.I = modPow(2n, (ED.p - 1n) / 4n, ED.p);
  ED.B = (function () { var y = 4n * modPow(5n, ED.p - 2n, ED.p) % ED.p; return edDecode(bnToLE(y, 32), true); })();      // the base point: y = 4/5, x positive
  function edAdd(P, Q) {                // RFC 8032 section 5.1.4, "add-2008-hwcd-3"
    var p = ED.p, A = mod((P[1] - P[0]) * (Q[1] - Q[0]), p), B = mod((P[1] + P[0]) * (Q[1] + Q[0]), p), C = mod(2n * P[3] * Q[3] * ED.d, p), D = mod(2n * P[2] * Q[2], p);
    var E = B - A, F = D - C, G = D + C, H = B + A;
    return [mod(E * F, p), mod(G * H, p), mod(F * G, p), mod(E * H, p)];
  }
  function edMul(s, P) { var Q = [0n, 1n, 1n, 0n]; while (s > 0n) { if (s & 1n) Q = edAdd(Q, P); P = edAdd(P, P); s >>= 1n; } return Q; }
  function edEncode(P) { var p = ED.p, zi = modPow(P[2], p - 2n, p), x = P[0] * zi % p, y = P[1] * zi % p, out = bnToLE(y, 32); out[31] |= Number(x & 1n) << 7; return out; }
  function edDecode(b, forceEven) {     // RFC 8032 section 5.1.3
    var p = ED.p, y = bnFromLE(b) & ((1n << 255n) - 1n), sign = forceEven ? 0 : (b[31] >> 7);
    if (y >= p) return null;
    var y2 = y * y % p, u = mod(y2 - 1n, p), v = mod(ED.d * y2 + 1n, p), x = mod(u * modPow(v, 3n, p) % p * modPow(u * modPow(v, 7n, p) % p, (p - 5n) / 8n, p), p), vx2 = v * x % p * x % p;
    if (vx2 === mod(-u, p)) x = x * ED.I % p; else if (vx2 !== u) return null;
    if (x === 0n && sign) return null;
    if (Number(x & 1n) !== sign) x = p - x;
    return [x, y, 1n, x * y % p];
  }
  async function sha512(data) { return new Uint8Array(await subtle.digest('SHA-512', data)); }
  function catBytes() { return bytesLib.concat.apply(null, arguments); }
  async function ed25519SignJS(seed, msg) {
    var h = await sha512(seed), a = h.slice(0, 32); a[0] &= 248; a[31] &= 127; a[31] |= 64; var an = bnFromLE(a), prefix = h.slice(32);
    var A = edEncode(edMul(an, ED.B)), r = mod(bnFromLE(await sha512(catBytes(prefix, msg))), ED.L), R = edEncode(edMul(r, ED.B));
    var k = mod(bnFromLE(await sha512(catBytes(R, A, msg))), ED.L), S = mod(r + k * an, ED.L);
    return catBytes(R, bnToLE(S, 32));
  }
  async function ed25519VerifyJS(pub, sig, msg) {
    if (sig.length !== 64 || pub.length !== 32) return false;
    var A = edDecode(pub), R = edDecode(sig.slice(0, 32)), S = bnFromLE(sig.slice(32)); if (!A || !R || S >= ED.L) return false;
    var k = mod(bnFromLE(await sha512(catBytes(sig.slice(0, 32), pub, msg))), ED.L);
    var lhs = edEncode(edMul(S, ED.B)), rhs = edEncode(edAdd(R, edMul(k, A)));
    for (var i = 0, d = 0; i < 32; i++) d |= lhs[i] ^ rhs[i]; return d === 0;
  }
  function ed25519Public(seed) { return sha512(seed).then(function (h) { var a = h.slice(0, 32); a[0] &= 248; a[31] &= 127; a[31] |= 64; return edEncode(edMul(bnFromLE(a), ED.B)); }); }

  async function probe(alg, usage) { try { await subtle.generateKey(alg, true, usage); return true; } catch (e) { return false; } }
  var cryptoHas = { x25519: null, ed25519: null };
  async function hasX25519() { if (cryptoHas.x25519 === null) cryptoHas.x25519 = await probe({ name: 'X25519' }, ['deriveBits']); return cryptoHas.x25519; }
  async function hasEd25519() { if (cryptoHas.ed25519 === null) cryptoHas.ed25519 = await probe({ name: 'Ed25519' }, ['sign', 'verify']); return cryptoHas.ed25519; }
  function rawPub(jwkOrRaw) { return jwkOrRaw; }
  function jwkB64(b) { return btoa(String.fromCharCode.apply(null, b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
  function fromB64url(s) { return b64bytes(s.replace(/-/g, '+').replace(/_/g, '/')); }


  /* Blowfish, only enough of it for OpenSSH's bcrypt_pbkdf (eksblowfish). The P and S boxes are the digits of pi;
     they are kept as base64 to spare the source their thousands of constants, and expanded once on first use. */
  var BF = null;
  function bfInit() {
    if (BF) return BF;
    var P = new Uint32Array(18), S = new Uint32Array(1024), src = bfConst();
    for (var i = 0; i < 18; i++) P[i] = src[i]; for (i = 0; i < 1024; i++) S[i] = src[18 + i];
    return (BF = { P: P, S: S });
  }
  function bfF(S, x) { return ((((S[(x >>> 24) & 0xff] + S[256 + ((x >>> 16) & 0xff)]) >>> 0) ^ S[512 + ((x >>> 8) & 0xff)]) + S[768 + (x & 0xff)]) >>> 0; }
  function bfEnc(P, S, l, r) { for (var i = 0; i < 16; i += 2) { l ^= P[i]; r = (r ^ bfF(S, l)) >>> 0; r ^= P[i + 1]; l = (l ^ bfF(S, r)) >>> 0; } l ^= P[16]; r ^= P[17]; return [r >>> 0, l >>> 0]; }
  function bfStream(data, at) { return ((data[at & (data.length - 1)] << 24) | (data[(at + 1) & (data.length - 1)] << 16) | (data[(at + 2) & (data.length - 1)] << 8) | data[(at + 3) & (data.length - 1)]) >>> 0; }
  function bfExpandKey(P, S, key, data) {
    var j = { v: 0 };
    function next(src) { var v = bfStream(src, j.v); j.v = (j.v + 4) % src.length; return v; }
    for (var i = 0; i < 18; i++) P[i] ^= next(key);
    var l = 0, r = 0, o;
    for (i = 0; i < 18; i += 2) { l ^= bfStream(data, (i * 2) % data.length); r ^= bfStream(data, (i * 2 + 4) % data.length); o = bfEnc(P, S, l, r); P[i] = o[0]; P[i + 1] = o[1]; l = o[0]; r = o[1]; }
    for (i = 0; i < 1024; i += 2) { l ^= bfStream(data, (i * 2) % data.length); r ^= bfStream(data, (i * 2 + 4) % data.length); o = bfEnc(P, S, l, r); S[i] = o[0]; S[i + 1] = o[1]; l = o[0]; r = o[1]; }
  }
  async function bcryptHash(pass, salt) {                    // OpenSSH's "bcrypt" block: 64 rounds of eksblowfish over the fixed magic
    var base = bfInit(), P = base.P.slice(), S = base.S.slice();
    bfExpandKey(P, S, salt, pass);
    for (var i = 0; i < 64; i++) { bfExpandKey(P, S, new Uint8Array(16), pass); bfExpandKey(P, S, new Uint8Array(16), salt); }   // expand with zero data, alternating pass and salt
    var ct = B_encode('OxychromaticBlowfishSwatDynamite'), words = new Uint32Array(8);
    for (i = 0; i < 8; i++) words[i] = (ct[i * 4] << 24 | ct[i * 4 + 1] << 16 | ct[i * 4 + 2] << 8 | ct[i * 4 + 3]) >>> 0;
    for (i = 0; i < 64; i++) for (var j = 0; j < 8; j += 2) { var o = bfEnc(P, S, words[j], words[j + 1]); words[j] = o[0]; words[j + 1] = o[1]; }
    var out = new Uint8Array(32);
    for (i = 0; i < 8; i++) { out[i * 4] = words[i] & 255; out[i * 4 + 1] = (words[i] >>> 8) & 255; out[i * 4 + 2] = (words[i] >>> 16) & 255; out[i * 4 + 3] = (words[i] >>> 24) & 255; }   // little-endian, as OpenSSH stores it
    return out;
  }
  function B_encode(s) { return new TextEncoder().encode(s); }
  async function bcryptPbkdf(password, salt, keylen, rounds) {
    var sha512 = async function (d) { return new Uint8Array(await subtle.digest('SHA-512', d)); };
    var passHash = await sha512(password), stride = Math.floor((keylen + 31) / 32), amt = Math.floor((keylen + stride - 1) / stride), out = new Uint8Array(keylen), countbuf = new Uint8Array(4);
    var key = new Uint8Array(keylen);
    for (var block = 1; amt > 0; block++) {
      countbuf[0] = (block >>> 24) & 255; countbuf[1] = (block >>> 16) & 255; countbuf[2] = (block >>> 8) & 255; countbuf[3] = block & 255;
      var saltHash = await sha512(bytesLib.concat(salt, countbuf)), tmp = await bcryptHash(passHash, saltHash), res = tmp.slice();
      for (var r = 1; r < rounds; r++) { tmp = await bcryptHash(passHash, await sha512(tmp)); for (var i = 0; i < 32; i++) res[i] ^= tmp[i]; }
      var count = Math.min(amt, stride);
      for (i = 0; i < count; i++) { var dest = i * stride + (block - 1); if (dest < keylen) key[dest] = res[i]; }        // the interleaving OpenSSH does
      amt -= count;
    }
    return key;
  }
  function bfConst() { return bfConstCache || (bfConstCache = decodeBfConst()); }
  var bfConstCache = null;
  function decodeBfConst() { var raw = b64bytes(BF_CONST_B64), out = new Uint32Array(raw.length / 4); for (var i = 0; i < out.length; i++) out[i] = (raw[i * 4] << 24 | raw[i * 4 + 1] << 16 | raw[i * 4 + 2] << 8 | raw[i * 4 + 3]) >>> 0; return out; }
  var BF_CONST_B64 = 'JD9qiIWjCNMTGYouA3BzRKQJOCIpnzHQCC76mOxObIlFKCHmONATd75UZs806QxswKwpt8l8UN0/hNW1tUcJF5IW1dmJefsb0TELppjftawv/XLb0Brft7jhr+1qJn6WunyQRfEsf5kkoZlHs5Fs9wgB8uKFjvwWY2kg2HFXTmmkWP6j9JM9fg2VdI9yjrZYcYvNWIIVSu57VKQdwlpZtZww1Tkq8mATxdGwIyhghfDKQXkYuNs474553LBgOhgObJ4Oi7Aeij7XFXfBvTFLJ3ivL9pVYFxg5lUl86pVq5RXSJhiY+gUQFXKOWoqqxC2tMxcNBFB6M6hVIavfHLpk7PuFBFjb7wqK6nFXXQYMfbOXD4Wm4eTHq/WujNsJM9cejJTgSiVhnc7j0iYa0u5r8S/6BtmKCGTYdgJzPshqZFIfKxgXeyAMu+EXV3phXWx3CYjAutlG4gjiT6B05asxQ9tb/OD9EI5LgtEgqSEIARpyPBKnh+bXiHGaEL26WyaZwycYavTiPBqUaDS2FQvaJYPpyirUTOjbu8LbBN6O+S6O/BQfvsqmKHxZR05rwF2ZspZPoJDDoiM7oYZRW+ftH2EpcM7i16+4G912IXBIHNAGkSfVsFqpk7TqmI2P3cGG/7fckKbAj030Nck0AoSSNsP6tNJ8cCbB1NyyYCZG3sl1HnY9uje9+P+UBq2eUw7l2zgvQTABrrBqU+2QJ9gxF5cnsIZaiRjaPtvrz5sU7UTObLrO1Lsb238UR+bMJUszIFFRK9evQm+49AE3jNK/WYPKAcZLkuzwMuoV0XIdA/SC185udP721V5wL0aYDIK1qEAxkAscnlnnyX++x+jzI6l6fjbMiL4PHUW3/1haxUvUB7IrQVSqzI9tfr9I4dgUzF7SD4A34KeXFe7ym+MoBqHVi7fF2nb1UKo9ih+/8OsZzLGjE9Vc2lbJ7C7yljI4f+jXbjwEaAQ+j2Y/SGDuEr8tWwt0dNbmlPkebb4RWXSjkm8S/uXkOHd8tqky34zYvsTQc7kxujvIMraNndMAdB+nv4r8R+0ldvaTa6QkZjqrY5xa5PVoNCO0dCvxyXgjjxbL451lLeP9uL78hIrZIiIuBKQDfAcT61eoGiPwxzRz/GRs6jBrS8vIhi+Dhd36nUt/osCH6HloMwPtW906Bis89bOieKZtKhP4P0T4Ld8xDuB0q2o2RZfomaAlXcFk8xzFCEaFHfmrSBld7X6hsdUQvX7nTXP682vDHs+iaDWQRvTrh5+SQAlDi0gcbNeImgAu1e44K8kZDab8Am5HlVjkR1Z36aqeMFDidlaU38gfVuiAuW5xYMmA3Zilc+pEcgZaE5zSkGzRy3KexSpShtRAFKaUykV1g9XP7ybxuQrYKR2geZ0AAi6b7VXG+kf8pbsayoN2RW2Y2Uh57n5tv80BS7FhVZkU7AtXamfj6EIukeZboUHakt6cOm1sylE23UJLsQZJiOtbqawSafffZzuYLiP7bJm7KqMcWmaF/9WZFJswrGe4Rk2AqV1CUwpoFkTQOQYOj4/VJiaW0KdZWuP5NaZ9z/WodKcB+/oMPVNLTjm8CVdwUzdIIaEcOsmY4LpxgIezF4JaGs/PrrvyTyXGBRranChaH81hFKg4oa3nFMFqlAHNz4HhBx/3q5cjn1E7FcW8riwOto38FAMDfAcHwQCALP/rgz1Gjy1dLIlg3pY3AkhvdGRE/l8qS/2lDJHcyL1RwE65eWBN8La3Mi1djSa892nqURhRg/QAw7syMc+pHUeQeI4zZk76g4vMoC7oRg+szFOVIs4T225CG9CDQP2CgS/LLgSkCSXfHlWebByvK+Jr96adx/ZkwgQs4uuEtzPPy5VEnIfLmtxJFAa3eafhM2HelhHGHQI2he8n5q86Ut9jOx67DrbhR36YwlDZsRkw9LvHBhHMhXZCN1DOzckwroWEqFNQyplxFFQlAACEzrk3XHf+J4QMU5Vgax31l8RGZsENVbx16PHazwRGDtZJKUJ8o/m7Zfx+/qeur8sHhU8bobjRXDq6W+xhg5eClo+KrN3H+ccTj0G+ill3LmZ5x0PgD6J1lJmyCUuTMl4nBCzasYVDrqU4up4pfw8Ux4KLfTy906nNh0rPRk5Jg8ZwnlgUiOnCPcTErbrrf5u6sMfZuO8RZWme8iDsX830QGM/yjDMt3vvmxapWVYIYVoq5gC7s6lD9svlTsq732tW24vhBUhtigpB2Fw7N1HdWGfFRATzKgw62G9lgM0/h6qA2PPtXNckExwojnVnp4Ly6reFO7MhrxgYiynnKtcq7LzhG5kix6vGb3wyqAjabllWrtQQGhaMjwqtLMxnunVwCG495tUCxmHX6CZlfeZfmI9faj4N4ial+MtdxHtk18WaBKBDjWIKcfmH9aW3t+heFi6mVf1hKUbInJjm4PD/xrCRpbNswrrUy4wVI/ZSORtvDEoWOvy7zTG/+r+KO1h7nw8c11KFNnoZLfjQhBdFCA+E+BF7uK2o6qr6ttsTxX6y0/Qx0L0Qu9qu7VlTzsdQc0hBdgeeZ6GhU3H5EtHaj2BYlDPYqHyW40mRvyIg6DBx7ajfxUkw2nLdJJHhIoLVpKyhQlbvwCtGUidFGKxdCOCDgBYQo0qDFX16h2t9D4jP3BhM3Lwko2TfkHWX+zxbCI723zeN1nL7nRgQIXyp853Mm6mB4CEGfhQnujv2FVh2Zc1qWmnqsUMBsJaBKv8gAvK3J5Eei7DRTSE/dVnBQ4ensnbc9vTEFWIzWdf2nnjZ0NAxcQ0ZXE+ONg9KPie8W3/IBU+IeePsD1K5uOfK9uDrffpPVpolIFA9/ZMJhyUaSk0QRUg93YC1Pe89Gsu1KIAaNQIJHEzIPRqQ7fUt1AAYa8eOfYulyRFRhQhT3S/i4hATZX8HZa1ka9w9N3TZqAvRb+8CewDvZeFf6xt0DHLhQSW6yezVf05QdolR+arygqaKFB4JVMEKfQKLIba6bZt+2jcFGLXSGkAaA7ApCehje5PP/6i6IetjLWM4AZ69Na2qs4efNM3X+zOeKOZQGsqQiD+njXZ84W57jnXqzsSTosdyfr3S20YViajZjHq45eyOm76dN1bQzJoQef3yngg+/sK9U7Y/rOXRUBWrLpIlSdVUzo6IIONh/5rqbfQlpVLVahnvKEVmljMqSljmeHbM6YqSlY/MSX5XvR+HJApMXz9+OgCBCcvcIC7FVwFKCzjlcEVSOTGbSJIwRM/xw+G3Af5ye5BBB8PQEd5pF2IbhcyX1Hr1ZvA0fK8wY9BETVkJXt4NGAqnGDf+OijH2NsGw4StMIC4TKer2ZP0crRgRVrI5XgMz6S4TskC2LuvrkihbKiDua6DZnecgyMLaL3KNASeEWVt5T9ZH0IYufM9fBUSaNvh31I+sOd/SfzPo0eCkdjQZku/3Q6b26r9Pj9N6gS3GCh6934mRvhTNtuaw3Ge1UQbWcsNydl1Dvc0OgE8SkNx8wA/6O1OQ+SaQ/tC2Z7n/vO232coJHPC9kVXqO7Ey+IUVutJHuUeb92O9brNzkus8wRWXmAJuKX9C4xLWhCrafGais7EnVMzHgu8RxqEkI3t5JR5wahu+ZL+2NQGmsQGBHK7fo9Jb3Y4uHDyURCFlkKEhOG2QzsbtWr6ipkr2dO2oaoX76/6Yhk5MP+nbyAV/D3wIZgeHv4YANgTdH9g0b2OB+wd0WuBNc2/MyDQmsz8B6rcbCAQYc8AF5fd6BXvr3oriRVRkKZv1guYU5Y9I/y3f2i9HTvOIeJvcJTZvnDyLOOdLR18lVG/Nm5eusmYYsd34SEag55kV+V4kZuWY4gtFdwjNVVkckC3ky5C6zhu4IF0BGoYkh1dKmet38ZtuCp3AlmLQmhxDJGM+haHwIJ8L6MSpmgJR1u/hAauT0dC6Wk36GG8g8oaPFp3Lfag1c5Bv6h4s6bT81/UlARXgGnBoP6oAK1xA3m0Cea+Iwndz+GQcNgTAZhqAa18Bd6KMD1huAAYFiqMNx9YhHmntcjOOpjU8LdlMLCFjS7y+5WkLy23uv8faHOWR12bwXkCUt8AYg5cgo9fJJ8JIbjcl9yTZ25GsFbtNOeuPztVFV4CPyltdg9fNNNrQ/EHlDvXrFh5viihRTZbFETPG/Vx+dW4U7ENiq/zt3GyDfXmjI0kmOCEmcO+o5AYADgOjnON9P69c+rwnc3WsUtG1ywZ55PozdC04InQJm8m77VEY6dvw9zFdYtHH7HAMR7t4wbayGhkEWybrG+ajZutFdIqy+8lG55xqN20mVJwshTD/juRo3efdVzCh1M0E3GKTm726m6RlCslSbovl7jBKH61fBqLVGaY++M4pqG7iLAicK4QyQu9qUeA6qc8tCkg8Bhupvpak2P5RVQumRb1igmovmnOjrhS6mVhu9VYunHL+/T91L32j8Eb2l3+gpZgOSpFYewhgGbCeatOz7lk+mQ/VqeNNeXLPC32QIri1GW1aw6AX2mfdHPPtZ8fS0oH58lz63yuJta1rRyWoj1TOAprHHgGaXmR7Cs/e2T+pvo08SNKDtXzPjVZil5Ey4oeF8Bke11YFX3lg5E49NejBUFbdSI9G26A6FhJQVk8L3D654VPJBXopcnGuypOgcqGz9tmx5jIfX1nGb7JtzzGXUz2SixVf31A1Y0goq6PLsoUXcRwgrZ+KvMUWfMrZJfTegXUTgw3I43nVhikyD5kep6kML7PnvOUSHOZHdPvjKotuN+wyk9RkjeU2lkE+aAoq4IEN1tsiRphS39CQchZrOaRgpkRcDdWGzezxwgyK5bvvfdG1iNQMzSAX9rtOO73aJqfjpZ/0U+NQpEvLTN1XLqzqj6ZIS7jWYSrr88b0fSm+RjVC9dnq7Cdxv2TmNwdA4NjedbE1f4chZxr1N9XUBAywhOtOLMNNJGagEVr4ThsAQolZg6HQa4n7TObqBIbz87gjUgq4IBGh1LJ3In+GEVYLHnkz/cuzp5KzRFJb2giDnhUc55Sy8yybegH7rJ4BzIfrzH0fbPARHDoeiqxxqQh0nUT72a0Nrey9UK2jgDOcMqxpE2Z435MXzgsStP955Zt0P1uzry1Rn/J9lFnL+XIiwV5vwqD5H8cZuUFSX65ZNhzrac68KoZFkSuqjRtsEHXuMFagwQ0lBlywOkQuDsbg4WmNs7TJigvjJ46WSfH5Uy4NOS39OgNCuJcfIeGwp0QUujNIzFvnEgw3Yy2N81n42bmS8u5gtvRw/j8R3lTNpUHtrYkc5iec/NPn5vFhixZv0sHQWEj9LF9vsimfUj81emMnYjk6g1MVbMzQKs8IFiWnXrtW4WNpeI0nPM3pZikoG5SdBMUJAbccZWFObGx70yehQKReHQBsPye5rJqlP9YqgPALslv+I1vdL2cRJpBbIEAiK2y898zXacK1MRPsAWQOPTOKu9YCVHrfC6OCCc90bOdnevocUgdWBghcv+Torojdh6qvmwTPmqfhlIwlwC+4qMAcNq5Nbr4fmQ1PhpplzeoD8JJS3CCOaft05hMs534ltXj9/jOsNy5g==';

  var cryptoLib = {
    has: cryptoHas, hasX25519: hasX25519, hasEd25519: hasEd25519,
    random: bytesLib.random, modPow: modPow, bn: { fromBE: bnFromBE, toBE: bnToBE, fromLE: bnFromLE, toLE: bnToLE },
    sha256: async function (d) { return new Uint8Array(await subtle.digest('SHA-256', d)); }, sha512: sha512,
    sha1: async function (d) { return new Uint8Array(await subtle.digest('SHA-1', d)); },
    hash: async function (name, d) { return new Uint8Array(await subtle.digest(name, d)); },
    hmac: async function (hashName, key, data) { var k = await subtle.importKey('raw', key, { name: 'HMAC', hash: hashName }, false, ['sign']); return new Uint8Array(await subtle.sign('HMAC', k, data)); },
    /* AES-CTR as SSH uses it (RFC 4344): a 128-bit counter, the whole block incremented per block, carried across calls. */
    aesCtr: async function (key, iv) {
      var k = await subtle.importKey('raw', key, 'AES-CTR', false, ['encrypt', 'decrypt']), ctr = bnFromBE(iv), left = new Uint8Array(0);   // keystream left over from a partial block
      async function run(data) {
        var out = new Uint8Array(data.length), i = 0;
        for (; i < data.length && i < left.length; i++) out[i] = data[i] ^ left[i];
        left = left.slice(i); if (i === data.length) return out;
        var rest = data.subarray(i), blocks = Math.ceil(rest.length / 16), padded = new Uint8Array(blocks * 16); padded.set(rest);
        var ks = new Uint8Array(await subtle.encrypt({ name: 'AES-CTR', counter: bnToBE(ctr, 16), length: 128 }, k, padded));    // the tail beyond the data is pure keystream
        out.set(ks.subarray(0, rest.length), i); left = ks.slice(rest.length); ctr = (ctr + BigInt(blocks)) & ((1n << 128n) - 1n);
        return out;
      }
      return { encrypt: run, decrypt: run };                                     // CTR is its own inverse
    },
    /* AES-GCM as SSH uses it (RFC 5647): a 12-byte IV whose last 8 bytes are a counter the caller increments per
       packet (gcmNext), AAD of the length field, a 16-byte tag appended to the ciphertext. */
    aesGcm: async function (key) {
      var k = await subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt', 'decrypt']);
      return {
        seal: async function (iv, aad, plain) { return new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: iv, additionalData: aad, tagLength: 128 }, k, plain)); },
        open: async function (iv, aad, cipherAndTag) { try { return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: iv, additionalData: aad, tagLength: 128 }, k, cipherAndTag)); } catch (e) { return null; } }
      };
    },
    gcmNext: function (iv) { for (var i = 11; i >= 4; i--) { iv[i] = (iv[i] + 1) & 255; if (iv[i]) break; } return iv; },
    chacha20: chacha20, poly1305: poly1305,
    /* SSH chacha20-poly1305@openssh.com (the draft): K_2 (bytes 32..64) encrypts the 4-byte length at block counter 0;
       K_1 (bytes 0..32) encrypts the payload from block counter 1; the Poly1305 key is K_1's block 0. The nonce is the
       packet sequence number as a big-endian uint64. Returns an object over the two keys and the length-key. */
    chachaPoly: function (key64) {
      var k1 = key64.subarray(0, 32), k2 = key64.subarray(32, 64);
      function nonce(seq) { var n = new Uint8Array(8); n[0] = 0; n[1] = 0; n[2] = 0; n[3] = 0; n[4] = (seq >>> 24) & 255; n[5] = (seq >>> 16) & 255; n[6] = (seq >>> 8) & 255; n[7] = seq & 255; return n; }
      return {
        encLength: function (seq, lenBytes) { return chacha20(k2, 0, nonce(seq), lenBytes); },
        decLength: function (seq, lenCipher) { return chacha20(k2, 0, nonce(seq), lenCipher); },
        seal: function (seq, lenCipher, payload) {          // payload plaintext -> ciphertext + 16-byte tag, over lenCipher||ctPayload
          var nn = nonce(seq), polyKey = chacha20(k1, 0, nn, new Uint8Array(32)), ct = chacha20(k1, 1, nn, payload);
          var tag = poly1305(polyKey, bytesLib.concat(lenCipher, ct));
          return bytesLib.concat(ct, tag);
        },
        open: function (seq, lenCipher, ctAndTag) {         // -> payload plaintext, or null
          var ct = ctAndTag.subarray(0, ctAndTag.length - 16), tag = ctAndTag.subarray(ctAndTag.length - 16);
          var nn = nonce(seq), polyKey = chacha20(k1, 0, nn, new Uint8Array(32)), want = poly1305(polyKey, bytesLib.concat(lenCipher, ct));
          var d = 0; for (var i = 0; i < 16; i++) d |= tag[i] ^ want[i]; if (d) return null;
          return chacha20(k1, 1, nn, ct);
        }
      };
    },
    /* bcrypt-pbkdf (OpenSSH's KDF for encrypted private keys): Blowfish's expensive key setup, run over
       sha512(password) and sha512(salt+counter), 'rounds' times, mixed by XOR. About eighty lines of Blowfish. */
    bcryptPbkdf: async function (password, salt, keylen, rounds) { return bcryptPbkdf(password, salt, keylen, rounds); },
    /* ECDH on the NIST curves (RFC 5656): the public key is the uncompressed point, the shared secret its x. */
    ecdh: async function (curve) {
      var kp = await subtle.generateKey({ name: 'ECDH', namedCurve: curve }, false, ['deriveBits']), bits = { 'P-256': 256, 'P-384': 384, 'P-521': 528 }[curve];
      return {
        publicKey: async function () { return new Uint8Array(await subtle.exportKey('raw', kp.publicKey)); },
        shared: async function (peer) { var pk = await subtle.importKey('raw', peer, { name: 'ECDH', namedCurve: curve }, false, []); return new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: pk }, kp.privateKey, bits)); }
      };
    },
    x25519: async function () {
      if (await hasX25519()) {
        var kp = await subtle.generateKey({ name: 'X25519' }, false, ['deriveBits']);
        return { publicKey: async function () { return new Uint8Array(await subtle.exportKey('raw', kp.publicKey)); },
          shared: async function (peer) { var pk = await subtle.importKey('raw', peer, { name: 'X25519' }, false, []); return new Uint8Array(await subtle.deriveBits({ name: 'X25519', public: pk }, kp.privateKey, 256)); }, js: false };
      }
      var k = bytesLib.random(32), nine = new Uint8Array(32); nine[0] = 9;
      return { publicKey: async function () { return x25519JS(k, nine); }, shared: async function (peer) { return x25519JS(k, peer); }, js: true };
    },
    x25519JS: x25519JS,
    ed25519Verify: async function (pub, sig, msg) {
      if (await hasEd25519()) { try { var pk = await subtle.importKey('raw', pub, { name: 'Ed25519' }, false, ['verify']); return await subtle.verify('Ed25519', pk, sig, msg); } catch (e) { return false; } }
      return ed25519VerifyJS(pub, sig, msg);
    },
    ed25519Sign: ed25519SignJS, ed25519Public: ed25519Public, ed25519VerifyJS: ed25519VerifyJS,
    /* ECDSA (RFC 5656): SSH carries r and s as mpints; WebCrypto wants them as fixed-width r||s, and the hash named. */
    ecdsaVerify: async function (curve, pub, r, s, data) {
      var n = { 'P-256': 32, 'P-384': 48, 'P-521': 66 }[curve], hash = { 'P-256': 'SHA-256', 'P-384': 'SHA-384', 'P-521': 'SHA-512' }[curve];
      try { var pk = await subtle.importKey('raw', pub, { name: 'ECDSA', namedCurve: curve }, false, ['verify']); return await subtle.verify({ name: 'ECDSA', hash: hash }, pk, catBytes(bnToBE(bnFromBE(r), n), bnToBE(bnFromBE(s), n)), data); } catch (e) { return false; }
    },
    ecdsaSign: async function (curve, priv, pub, data) {
      var n = { 'P-256': 32, 'P-384': 48, 'P-521': 66 }[curve], hash = { 'P-256': 'SHA-256', 'P-384': 'SHA-384', 'P-521': 'SHA-512' }[curve];
      var jwk = { kty: 'EC', crv: curve, x: jwkB64(pub.slice(1, 1 + n)), y: jwkB64(pub.slice(1 + n)), d: jwkB64(bnToBE(bnFromBE(priv), n)) };
      var k = await subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: curve }, false, ['sign']), sig = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: hash }, k, data));
      return { r: sig.slice(0, n), s: sig.slice(n) };
    },
    /* RSA (RFC 8332): the public key as SSH gives it, e and n as mpints; the hash by name. */
    rsaVerify: async function (hashName, e, n, sig, data) {
      try { var jwk = { kty: 'RSA', n: jwkB64(bnToBE(bnFromBE(n), Math.ceil(bnFromBE(n).toString(2).length / 8))), e: jwkB64(bnToBE(bnFromBE(e), Math.ceil(bnFromBE(e).toString(2).length / 8))) };
        var pk = await subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: hashName }, false, ['verify']); return await subtle.verify('RSASSA-PKCS1-v1_5', pk, sig, data); } catch (x) { return false; }
    },
    fromB64url: fromB64url, toB64url: jwkB64
  };

  /* Known hosts (SSH.md section 4): keyed by host:port, holding the key type and the public key, per browser. */
  var HOSTS_KEY = 'cvwm.net.hosts';
  function hostsLoad() { try { return JSON.parse(localStorage.getItem(HOSTS_KEY) || '{}'); } catch (e) { return {}; } }
  function hostsSave(h) { try { localStorage.setItem(HOSTS_KEY, JSON.stringify(h)); } catch (e) { /* kept for this page */ } }
  function b64(bytes) { var s = ''; for (var i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); }
  var hostsLib = {
    get: function (host, port) { return hostsLoad()[host + ':' + port] || null; },
    set: function (host, port, type, key) { var h = hostsLoad(); h[host + ':' + port] = { type: type, key: b64(key), added: new Date().toISOString() }; hostsSave(h); },
    remove: function (host, port) { var h = hostsLoad(); delete h[host + ':' + port]; hostsSave(h); },
    list: function () { return hostsLoad(); },
    fingerprint: async function (key) { return 'SHA256:' + b64(await cryptoLib.sha256(key)).replace(/=+$/, ''); },
    /* Trust on first use: the first contact is confirmed by the user; a changed key is refused, and the dialog says how to
       remove the old one, offering no way past. Resolves true where the key is accepted. */
    confirm: async function (label, host, port, type, key) {
      var known = hostsLoad()[host + ':' + port], fp = await hostsLib.fingerprint(key), keyB64 = b64(key);
      if (known && known.type === type && known.key === keyB64) return true;
      if (known) {
        logAdd('error', 'net', label, 'host key changed for ' + host + ':' + port + ': known ' + known.type + ', offered ' + type + ' ' + fp);
        await chooseBox('Host key changed', 'The ' + type + ' key ' + host + ' port ' + port + ' now presents (' + fp + ') is not the one saved on ' + (known.added || '').slice(0, 10) + '. Someone may be intercepting the connection, or the host was reinstalled. The connection is refused. To accept a new key, remove the old one first: the root menu, Known hosts.', ['Close']);
        return false;
      }
      var choice = await chooseBox('Unknown host', 'The authenticity of ' + host + ' port ' + port + ' cannot be established. Its ' + type + ' key fingerprint is ' + fp + '. Connect, and trust this key from now on?', ['Cancel', 'Connect once', 'Connect and remember']);
      if (choice === 2) hostsLib.set(host, port, type, key);
      return choice > 0;
    }
  };
  function knownHostsWindow() {
    var known = hostsLoad(), rows = Object.keys(known).sort();
    var list = h('div', { class: 'fv-form' }, rows.length ? rows.map(function (k) {
      var e = known[k], b = h('button', { class: 'fv-btn sm', type: 'button', text: 'Remove' });
      b.addEventListener('click', function () { hostsLib.remove.apply(null, k.split(/:(?=[^:]+$)/)); w.close(); knownHostsWindow(); });
      return h('div', { class: 'fv-row' }, [h('b', { text: k, style: 'width:auto;font-family:var(--mono)' }), h('span', { text: e.type + ' \u00B7 ' + (e.added || '').slice(0, 10), style: 'flex:1;font:11px var(--mono)' }), b]);
    }) : [h('p', { text: 'No host keys are saved. A host is added the first time a connection to it is accepted.' })]);
    var w = new Win({ title: 'Known hosts', w: 560, h: 320, center: true, escCloses: true, content: list });
    return w;
  }

  /* A secret asked in a cvwm dialog: a hidden field, nothing echoed, the value handed only to the caller. */
  function askSecret(label, prompt, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var n = ++uid, f = field('fvs' + n, opts.label || 'Password', '', opts.echo ? 'text' : 'password'), answered = false;
      var cancel = h('button', { class: 'fv-btn', type: 'button', text: 'Cancel' }), ok = h('button', { class: 'fv-btn', type: 'button', text: opts.ok || 'OK' });
      var w = new Win({ title: opts.title || label, w: 480, h: 200, center: true, escCloses: true, onClose: function () { if (!answered) resolve(null); },
        content: h('div', { class: 'fv-form' }, [h('p', { text: prompt }), f.row, h('div', { class: 'fv-row end' }, [cancel, ok])]) });
      function submit() { answered = true; var v = f.input.value; f.input.value = ''; w.close(); resolve(v); }
      ok.addEventListener('click', submit); cancel.addEventListener('click', function () { w.close(); });
      w.el.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' && ev.target.tagName === 'INPUT') submit(); });
      f.input.focus();
    });
  }

  function netFor(label, labelId) {
    return {
      connect: function (host, port, opts) { return netConnect(label, host, port, Object.assign({ containerURI: apps[labelId] ? apps[labelId].containerURI : null }, opts || {})); },
      reader: function (socket) { return new Reader(socket); },
      bytes: bytesLib, NetError: NetError, crypto: cryptoLib,
      hosts: Object.assign({}, hostsLib, { confirm: function (host, port, type, key) { return hostsLib.confirm(label, host, port, type, key); } }),
      askSecret: function (prompt, opts) { return askSecret(label, prompt, opts); }
    };
  }


  /* ------------------------------------------------------------------ icons (inline SVG) */

  function svg(inner, size) {
    return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 40 40" fill="none" stroke="#000" stroke-width="1.6" ' +
      'stroke-linejoin="round" stroke-linecap="round" aria-hidden="true">' + inner + '</svg>';
  }
  var FOLDER = '<path d="M4 11H15L18 14H36V32H4Z" fill="FILL"/><path d="M4 17H36"/>';
  var DOC = '<path d="M10 4H25L31 10V36H10Z" fill="#fff"/><path d="M25 4V10H31"/>';
  var ICONS = {
    disk: '<rect x="3" y="9" width="34" height="22" rx="2" fill="#d8d8d8"/><path d="M3 25H37"/>' +
      '<circle cx="9" cy="28" r="1.2" fill="#1f7a3a" stroke="#1f7a3a"/><path d="M22 28H33"/>',
    diskOpen: '<rect x="3" y="9" width="34" height="22" rx="2" fill="#7f7f7f"/><path d="M3 25H37"/>' +
      '<circle cx="9" cy="28" r="1.2" fill="#9be8b0" stroke="#9be8b0"/><path d="M22 28H33"/>',
    home: '<path d="M6 19 L20 7 L34 19" fill="none"/><path d="M9 17 V33 H31 V17" fill="#d8d8d8"/><rect x="17" y="24" width="6" height="9" fill="#8a5a3a"/><path d="M6 19 L20 7 L34 19" fill="none"/>',
    homeOpen: '<path d="M6 19 L20 7 L34 19" fill="none"/><path d="M9 17 V33 H31 V17" fill="#7f7f7f"/><rect x="17" y="24" width="6" height="9" fill="#5a3a24"/><path d="M6 19 L20 7 L34 19" fill="none"/>',
    container: FOLDER.replace('FILL', '#e6cf8a'),
    system: FOLDER.replace('FILL', '#cfcfcf'),
    app: FOLDER.replace('FILL', '#e6cf8a') + '<path d="M11 21L15 24.5L11 28"/><path d="M18 28H25"/>',
    object: DOC + '<path d="M14 17H27M14 22H27M14 27H22"/>',
    script: DOC + '<path d="M17 18L13 23L17 28M24 18L28 23L24 28"/>',
    image: DOC + '<path d="M13 30L18 22L22 27L25 24L28 30Z" fill="#9ab"/><circle cx="17" cy="17" r="1.6"/>',
    pdf: DOC + '<rect x="13" y="16" width="15" height="10" fill="#c06077"/><path d="M14 31H27"/>',
    queue: '<rect x="7" y="7" width="26" height="7" fill="#fff"/><rect x="7" y="16.5" width="26" height="7" fill="#fff"/>' +
      '<rect x="7" y="26" width="26" height="7" fill="#fff"/>',
    reference: DOC + '<path d="M14 29C14 22 19 20 26 20"/><path d="M22 16L26 20L22 24"/>'
  };
  var VIEW_ICONS = {
    reload: '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="#000" stroke-width="1.6"><path d="M13 8a5 5 0 1 1-1.6-3.7" stroke-linecap="round"/><path d="M13 2.6V5.2H10.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    icons: '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" fill="#000"><rect x="1" y="1" width="5" height="5"/><rect x="8" y="1" width="5" height="5"/><rect x="1" y="8" width="5" height="5"/><rect x="8" y="8" width="5" height="5"/></svg>',
    list: '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" fill="#000"><rect x="1" y="2" width="2" height="2"/><rect x="5" y="2" width="8" height="2"/><rect x="1" y="6" width="2" height="2"/><rect x="5" y="6" width="8" height="2"/><rect x="1" y="10" width="2" height="2"/><rect x="5" y="10" width="8" height="2"/></svg>'
  };
  function icon(name, size) { return svg(ICONS[name] || ICONS.object, size || 40); }

  /* ------------------------------------------------------------------ scroll bars

     FVWM draws no scroll bars of its own; the ones seen beside it were the toolkit's, and these follow Motif: a
     sunken trough, a raised slider, and an arrow at each end that is itself a raised triangle. They replace the
     operating system's in the desktop and in every application window (the same rules go into each
     application's document, ahead of its own styles, so an application can recolour them through the two
     variables or restyle them outright).

     This much styling is only possible through ::-webkit-scrollbar, which Chromium and Safari have. Firefox takes
     the two colours and draws its own flat bar with them. Those standard properties are given only where the
     other form is missing, because a browser that is given both uses the standard ones and drops the rest. */
  function arrowURI(points, light, dark) {            // a raised triangle: lit along its upper-left edges, shaded along the others
    function line(seg, colour) { return "<path d='M" + seg.replace(' ', ' L') + "' stroke='" + colour + "' stroke-width='1.6' fill='none' stroke-linecap='square'/>"; }
    return 'url("data:image/svg+xml,' + encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' width='17' height='17' viewBox='0 0 17 17'>" +
      "<polygon points='" + points + "' fill='rgba(255,255,255,.42)'/>" + dark.map(function (d) { return line(d, 'rgba(0,0,0,.8)'); }).join('') + light.map(function (l) { return line(l, 'rgba(255,255,255,.95)'); }).join('') + '</svg>') + '")';
  }
  var SB_ARROWS = {
    up: arrowURI('8.5,3 14,13 3,13', ['3,13 8.5,3'], ['8.5,3 14,13', '3,13 14,13']),
    down: arrowURI('3,4 14,4 8.5,14', ['3,4 14,4', '3,4 8.5,14'], ['14,4 8.5,14']),
    left: arrowURI('3,8.5 13,3 13,14', ['3,8.5 13,3'], ['13,3 13,14', '3,8.5 13,14']),
    right: arrowURI('4,3 14,8.5 4,14', ['4,3 4,14', '4,3 14,8.5'], ['14,8.5 4,14'])
  };
  var SCROLLBAR_CSS = [
    ':root{--sb-face:#bfbfbf;--sb-trough:#9a9a9a}',
    '::-webkit-scrollbar{width:17px;height:17px;background:var(--sb-trough)}',
    '::-webkit-scrollbar-track{background:var(--sb-trough);box-shadow:inset 1px 1px 0 rgba(0,0,0,.55),inset -1px -1px 0 rgba(255,255,255,.55)}',
    '::-webkit-scrollbar-thumb{background:var(--sb-face);border:2px solid;border-color:rgba(255,255,255,.65) rgba(0,0,0,.58) rgba(0,0,0,.58) rgba(255,255,255,.65);min-height:26px;min-width:26px}',
    '::-webkit-scrollbar-thumb:active{background:var(--sb-face);filter:brightness(.94)}',
    '::-webkit-scrollbar-corner{background:var(--sb-face)}',
    /* One arrow at each end. They are named by where they sit (start, end) and what they do, not by ":single-button":
       that matches only where the platform places one button at each end, and on a platform that places them
       otherwise, or has none of its own (macOS), it matches nothing and no arrow is drawn. The two that would
       double up (an "increment" at the start, a "decrement" at the end) are the ones hidden. */
    '::-webkit-scrollbar-button{display:block;width:17px;height:17px;background-color:var(--sb-trough);background-repeat:no-repeat;background-position:center}',
    '::-webkit-scrollbar-button:start:increment,::-webkit-scrollbar-button:end:decrement{display:none}',
    '::-webkit-scrollbar-button:vertical:start:decrement{background-image:' + SB_ARROWS.up + ';box-shadow:inset 1px 1px 0 rgba(0,0,0,.55),inset -1px 0 0 rgba(255,255,255,.55)}',
    '::-webkit-scrollbar-button:vertical:end:increment{background-image:' + SB_ARROWS.down + ';box-shadow:inset 1px 0 0 rgba(0,0,0,.55),inset -1px -1px 0 rgba(255,255,255,.55)}',
    '::-webkit-scrollbar-button:horizontal:start:decrement{background-image:' + SB_ARROWS.left + ';box-shadow:inset 1px 1px 0 rgba(0,0,0,.55),inset 0 -1px 0 rgba(255,255,255,.55)}',
    '::-webkit-scrollbar-button:horizontal:end:increment{background-image:' + SB_ARROWS.right + ';box-shadow:inset 0 1px 0 rgba(0,0,0,.55),inset -1px -1px 0 rgba(255,255,255,.55)}',
    '::-webkit-scrollbar-button:active{filter:brightness(.88)}',
    '@supports not selector(::-webkit-scrollbar){*{scrollbar-color:var(--sb-face) var(--sb-trough);scrollbar-width:auto}}'
  ].join('\n');

  /* ------------------------------------------------------------------ stylesheet */

  var CSS = [
    ':root{--std:#60a0c0;--hi:#c06077;--grey:#bfbfbf;--lt:rgba(255,255,255,.6);--dk:rgba(0,0,0,.55);',
    '--sans:Helvetica,"Nimbus Sans","Liberation Sans",Arial,sans-serif;--mono:"DejaVu Sans Mono","Liberation Mono",Menlo,Consolas,monospace}',
    'html,body{margin:0;height:100%;overflow:hidden}',
    '#fv-root{position:fixed;inset:0;overflow:hidden;font:13px/1.3 var(--sans);color:#000;user-select:none;-webkit-user-select:none;',
    'background:#2f4f5f repeating-conic-gradient(#274452 0% 25%,#2f4f5f 0% 50%) 0 0/4px 4px;cursor:default}',
    '#fv-root *{box-sizing:border-box}',
    '.fv-view{position:absolute;left:0;top:0;transition:transform .18s ease-out;pointer-events:none}',   /* lets clicks through to the disks beneath */
    '@media (prefers-reduced-motion:reduce){.fv-view{transition:none}}',
    '.fv-up{border:2px solid;border-color:var(--lt) var(--dk) var(--dk) var(--lt)}',
    '.fv-down{border:2px solid;border-color:var(--dk) var(--lt) var(--lt) var(--dk)}',
    /* windows */
    '.fv-win{position:absolute;pointer-events:auto;background:var(--std);padding:5px;border:2px solid;border-color:var(--lt) var(--dk) var(--dk) var(--lt);outline:none}',
    '.fv-win.fv-focus{background:var(--hi)}',
    '.fv-inner{position:relative;z-index:1;width:100%;height:100%;display:flex;flex-direction:column;background:inherit;',
    'border:2px solid;border-color:var(--dk) var(--lt) var(--lt) var(--dk)}',
    '.fv-title{display:flex;height:22px;flex:none;background:inherit}',
    '.fv-tb{width:22px;height:22px;padding:0;background:transparent;display:flex;align-items:center;justify-content:center;cursor:default;',
    'border:2px solid;border-color:var(--lt) var(--dk) var(--dk) var(--lt)}',
    '.fv-tb:active{border-color:var(--dk) var(--lt) var(--lt) var(--dk)}',
    '.fv-tb i{display:block;border:1px solid;border-color:var(--lt) var(--dk) var(--dk) var(--lt)}',
    '.fv-tb.m i{width:10px;height:3px}.fv-tb.i i{width:4px;height:4px}.fv-tb.x i{width:12px;height:12px}',
    '.fv-tt{flex:1;min-width:0;font-weight:700;line-height:18px;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;',
    'padding:0 6px;cursor:move;border:2px solid;border-color:var(--lt) var(--dk) var(--dk) var(--lt)}',
    '.fv-client{position:relative;flex:1;min-height:0;display:flex;flex-direction:column;background:var(--grey);overflow:hidden}',
    '.fv-drop{position:absolute;inset:5px;z-index:5;display:none;pointer-events:none;border:3px solid #1f5fd0;background:rgba(31,95,208,.14);align-items:flex-end;justify-content:center}',
    '.fv-drop span{margin-bottom:10px;padding:2px 8px;background:#1f5fd0;color:#fff;font:700 12px var(--sans);max-width:90%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.fv-win.fv-over .fv-drop{display:flex}',
    '.fv-dragging iframe{pointer-events:none}',
    '.fv-item.fv-into,.fv-disk.fv-into{outline:3px solid #1f5fd0;outline-offset:1px;background:rgba(31,95,208,.14)}',
    '.fv-item.fv-open,.fv-disk.fv-open{outline:3px solid #1f9d55;outline-offset:1px;background:rgba(31,157,85,.16)}',   /* dropping an object onto an app: open with it */
    '.fv-item.fv-lifted{opacity:.45}',
    '.fv-client iframe{flex:1;width:100%;border:0;display:block;background:#000}',
    '.fv-rs{position:absolute;z-index:0}',
    '.fv-rs.n{left:24px;right:24px;top:-2px;height:9px;cursor:n-resize}.fv-rs.s{left:24px;right:24px;bottom:-2px;height:9px;cursor:s-resize}',
    '.fv-rs.w{top:24px;bottom:24px;left:-2px;width:9px;cursor:w-resize}.fv-rs.e{top:24px;bottom:24px;right:-2px;width:9px;cursor:e-resize}',
    '.fv-rs.nw,.fv-rs.ne,.fv-rs.sw,.fv-rs.se{width:26px;height:26px}',
    '.fv-rs.nw{left:-2px;top:-2px;cursor:nw-resize}.fv-rs.ne{right:-2px;top:-2px;cursor:ne-resize}',
    '.fv-rs.sw{left:-2px;bottom:-2px;cursor:sw-resize}.fv-rs.se{right:-2px;bottom:-2px;cursor:se-resize}',
    '.fv-rs.nw:before,.fv-rs.ne:before,.fv-rs.sw:before,.fv-rs.se:before,.fv-rs.nw:after,.fv-rs.ne:after,.fv-rs.sw:after,.fv-rs.se:after',
    '{content:"";position:absolute;background:var(--dk)}',
    '.fv-rs.nw:before{right:0;top:2px;width:2px;height:5px}.fv-rs.nw:after{left:2px;bottom:0;width:5px;height:2px}',
    '.fv-rs.ne:before{left:0;top:2px;width:2px;height:5px}.fv-rs.ne:after{right:2px;bottom:0;width:5px;height:2px}',
    '.fv-rs.sw:before{right:0;bottom:2px;width:2px;height:5px}.fv-rs.sw:after{left:2px;top:0;width:5px;height:2px}',
    '.fv-rs.se:before{left:0;bottom:2px;width:2px;height:5px}.fv-rs.se:after{right:2px;top:0;width:5px;height:2px}',
    '.fv-max .fv-rs{display:none}',
    '.fv-shield{position:absolute;inset:0;z-index:100000;display:none}',
    /* capture: the region-select overlay */
    '.fv-capsel{position:fixed;inset:0;z-index:100001;cursor:crosshair;background:rgba(0,0,0,.12)}',
    '.fv-capbox{position:fixed;display:none;border:1px dashed #fff;outline:1px solid #000;background:rgba(96,160,192,.18);pointer-events:none}',
    /* desktop furniture */
    '.fv-disks{position:absolute;right:8px;top:12px;bottom:150px;left:50%;display:flex;flex-flow:column wrap-reverse;align-content:flex-start;gap:14px 4px;pointer-events:none}',
    '.fv-disk{width:100px;display:flex;flex-direction:column;align-items:center;gap:3px;pointer-events:auto;background:none;border:0;padding:0;font:inherit;color:inherit}',
    '.fv-disk span{font-weight:500;font-size:12px;line-height:15px;padding:0 4px;background:#fff;color:#000;max-width:100px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.fv-disk.sel span,.fv-disk:focus-visible span{background:#000;color:#fff}.fv-disk:focus{outline:none}',
    '.fv-disk.home span{background:#f0e6a0}.fv-disk.home.sel span,.fv-disk.home:focus-visible span{background:#000}',
    '.fv-disk.cross span{background:#cfe4ff}.fv-disk.cross.sel span,.fv-disk.cross:focus-visible span{background:#000}',   /* a disk at another origin */
    '.fv-disk.locked svg{opacity:.55}',
    '.fv-icons{position:absolute;left:12px;bottom:12px;right:210px;display:flex;flex-wrap:wrap-reverse;gap:10px;pointer-events:none}',
    '.fv-icon{width:100px;display:flex;flex-direction:column;align-items:center;pointer-events:auto;background:none;border:0;padding:0;font:inherit;color:inherit}',
    '.fv-icon b{display:flex;background:var(--std);padding:4px;border:2px solid;border-color:var(--lt) var(--dk) var(--dk) var(--lt)}',
    '.fv-icon span{width:100px;background:var(--std);font-weight:700;font-size:11px;line-height:15px;text-align:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;',
    'border:2px solid;border-color:var(--lt) var(--dk) var(--dk) var(--lt)}',
    '.fv-icon:hover b,.fv-icon:hover span,.fv-icon:focus-visible b,.fv-icon:focus-visible span{background:var(--hi)}.fv-icon:focus{outline:none}',
    '.fv-pager{position:absolute;right:12px;bottom:12px;width:180px;height:116px;background:var(--std);padding:3px;display:grid;',
    'border:2px solid;border-color:var(--lt) var(--dk) var(--dk) var(--lt)}',
    '.fv-desk{position:relative;overflow:hidden;background:#8f8f8f;border:1px solid #000;padding:0;font:inherit}',
    '.fv-desk.cur{background:#5c54c0}.fv-desk:focus-visible{outline:2px solid #fff;outline-offset:-3px}',
    '.fv-desk u{position:absolute;display:block;background:var(--std);border:1px solid #000;min-width:3px;min-height:3px}.fv-desk u.f{background:var(--hi)}',
    /* menus */
    '.fv-menu{position:absolute;z-index:200000;min-width:190px;background:var(--grey);padding:2px;display:flex;flex-direction:column;',
    'border:2px solid;border-color:var(--lt) var(--dk) var(--dk) var(--lt)}',
    '.fv-menu h6{margin:0 0 2px;font:700 13px/20px var(--sans);text-align:center;background:var(--std);border:1px solid;border-color:var(--lt) var(--dk) var(--dk) var(--lt)}',
    '.fv-mi{display:flex;justify-content:space-between;align-items:center;gap:16px;height:24px;padding:0 10px;background:none;border:1px solid transparent;',
    'font:13px var(--sans);color:#000;text-align:left;white-space:nowrap}',
    '.fv-mi:hover,.fv-mi:focus-visible,.fv-mi.open{background:var(--hi);border-color:var(--lt) var(--dk) var(--dk) var(--lt);outline:none}',
    '.fv-mi[disabled]{color:#666;background:none;border-color:transparent}',
    '.fv-sep{height:0;border-top:1px solid var(--dk);border-bottom:1px solid var(--lt);margin:3px 2px}',
    /* widgets */
    '.fv-btn{min-width:84px;height:28px;padding:0 12px;background:var(--grey);font:700 13px var(--sans);color:#000;border:2px solid;border-color:var(--lt) var(--dk) var(--dk) var(--lt)}',
    '.fv-btn:active{border-color:var(--dk) var(--lt) var(--lt) var(--dk)}.fv-btn:focus-visible{outline:1px solid #000;outline-offset:2px}',
    '.fv-btn.sm{min-width:0;height:22px;padding:0 8px;font-size:12px}',
    '.fv-btn:disabled{color:#7a7a7a;text-shadow:1px 1px 0 rgba(255,255,255,.6)}.fv-btn:disabled:active{border-color:var(--lt) var(--dk) var(--dk) var(--lt)}',
    '.fv-in{height:26px;padding:0 6px;background:#fff;color:#000;font:13px var(--mono);border:2px solid;border-color:var(--dk) var(--lt) var(--lt) var(--dk);user-select:text;-webkit-user-select:text}',
    '.fv-in:focus{outline:1px solid #000}',
    '.fv-in:disabled{background:var(--grey);color:#7a7a7a;cursor:not-allowed}',
    '.fv-form{flex:1;padding:14px 16px;display:flex;flex-direction:column;gap:10px;overflow:auto}',
    '.fv-acl{display:flex;flex-direction:column;gap:8px}',
    '.fv-acl-list{display:flex;flex-direction:column;gap:8px}',
    '.fv-acl-ace{border:1px solid var(--line);border-radius:4px;padding:8px;display:flex;flex-direction:column;gap:6px;background:var(--panel)}',
    '.fv-acl-head{display:flex;gap:6px;align-items:center}',
    '.fv-acl-head .fv-acl-type{flex:none;width:78px}',
    '.fv-acl-head input{flex:1;min-width:0}',
    '.fv-acl-head .fv-acl-preset{flex:none;width:120px}',
    '.fv-acl-rm{flex:none;width:26px;padding:0;font-weight:700}',
    '.fv-acl-bits{display:grid;grid-template-columns:1fr 1fr;gap:2px 12px;padding:2px 0}',
    '.fv-acl-flags{display:flex;flex-wrap:wrap;gap:2px 12px}',
    '.fv-acl-flagrow{display:flex;gap:8px;align-items:flex-start}',
    '.fv-acl-flabel{font-size:11px;color:var(--muted);flex:none;width:78px;padding-top:2px}',
    '.fv-acl-bit{display:flex;gap:5px;align-items:center;font-size:12px;font-family:var(--mono);white-space:nowrap}',
    '.fv-acl-bit input{flex:none;margin:0}',
    '.fv-droppane{position:absolute;inset:0;z-index:8;display:flex;align-items:center;justify-content:center;background:var(--grey);text-align:center}',
    '.fv-droppane.over{background:#dfe8fb;outline:3px dashed #1f5fd0;outline-offset:-8px}',
    '.fv-droppane-msg{display:flex;flex-direction:column;align-items:center;gap:10px;color:#000;font:14px var(--sans);padding:20px}',
    '.fv-droppane-msg p{margin:0}.fv-droppane-msg p span{color:#555;font-size:12px}',
    '.fv-droppane-icon{opacity:.7}',
    '.fv-pick{flex:1;display:flex;flex-direction:column;gap:8px;padding:10px;min-height:0}',
    '.fv-pick .where{font:12px var(--mono);color:#000;background:var(--grey);border:2px solid;border-color:var(--dk) var(--lt) var(--lt) var(--dk);padding:3px 6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.fv-pick .rows{flex:1;overflow:auto;background:#fff;border:2px solid;border-color:var(--dk) var(--lt) var(--lt) var(--dk);padding:2px}',
    '.fv-pick .rows button{display:flex;align-items:center;gap:8px;width:100%;text-align:left;border:0;background:none;padding:4px 8px;font:13px var(--sans);color:#000;cursor:pointer}',
    '.fv-pick .rows button:hover{background:#000080;color:#fff}.fv-pick .rows button:hover i{filter:none}',
    '.fv-pick .rows button.dim{color:#666}.fv-pick .rows button:hover.dim{color:#fff}',
    '.fv-pick .rows button.sel{background:#000080;color:#fff}.fv-pick .rows button.sel i{filter:none}.fv-pick .rows button.sel.dim{color:#fff}',
    '.fv-pick .rows button .nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.fv-pick .rows button .ver{flex:none;font:10px var(--sans);color:#2a7d3a;border:1px solid #2a7d3a;border-radius:3px;padding:0 3px;line-height:14px}',
    '.fv-pick .rows button:hover .ver,.fv-pick .rows button.sel .ver{color:#fff;border-color:#fff}',
    '.fv-pick .rows i{width:16px;height:16px;display:inline-flex;flex:none}.fv-pick .rows i svg{width:16px;height:16px}',
    '.fv-pick .rows p{color:#555;padding:8px;margin:0;font:13px var(--sans)}',
    '.fv-pick .hint{font:11px var(--sans);color:#a33;min-height:13px;margin:-2px 2px 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    /* the Open/Save dialog in a dark theme, selected by the calling application (pickObject opts.theme) */
    '.fv-win.fv-dark{--std:#2c3d47;--hi:#3a4e59;--grey:#333b41;--lt:rgba(255,255,255,.16);--dk:rgba(0,0,0,.6)}',
    '.fv-win.fv-dark .fv-tt,.fv-win.fv-dark .fv-btn{color:#e8edf1}',
    '.fv-win.fv-dark .fv-pick .where{color:#aeb9c2;background:#23292e}',
    '.fv-win.fv-dark .fv-pick .rows{background:#1b1f23}',
    '.fv-win.fv-dark .fv-pick .rows button{color:#d7dee4}',
    '.fv-win.fv-dark .fv-pick .rows button:hover,.fv-win.fv-dark .fv-pick .rows button.sel{background:#3a6ea5;color:#fff}',
    '.fv-win.fv-dark .fv-pick .rows button.dim{color:#71797f}',
    '.fv-win.fv-dark .fv-pick .rows button .ver{color:#7ec98f;border-color:#7ec98f}',
    '.fv-win.fv-dark .fv-pick .rows p{color:#8a929a}',
    '.fv-win.fv-dark .fv-pick .hint{color:#ff8a8a}',
    '.fv-win.fv-dark .fv-in{background:#15191c;color:#e8edf1}',
    /* the whole desktop in a dark theme, chosen from the root menu (the shared cvwm.dark setting). Structural
       colours come from the tokens; the rules below re-cast the surfaces and text that are otherwise fixed light. */
    '#fv-root.fv-dark{--std:#2c3d47;--hi:#3a4e59;--grey:#333b41;--lt:rgba(255,255,255,.16);--dk:rgba(0,0,0,.6);--sb-face:#333b41;--sb-trough:#23292e;color:#e8edf1;',
    'background:#1a2830 repeating-conic-gradient(#16232b 0% 25%,#1a2830 0% 50%) 0 0/4px 4px}',
    '#fv-root.fv-dark .fv-mi,#fv-root.fv-dark .fv-btn,#fv-root.fv-dark .fv-menu h6,#fv-root.fv-dark .fv-layer,#fv-root.fv-dark .fv-lhead button{color:#e8edf1}',
    '#fv-root.fv-dark .fv-mi[disabled]{color:#71797f}',
    '#fv-root.fv-dark .fv-btn:disabled{color:#71797f;text-shadow:none}',
    '#fv-root.fv-dark .fv-btn:focus-visible,#fv-root.fv-dark .fv-refresh:focus-visible,#fv-root.fv-dark .fv-views button:focus-visible,#fv-root.fv-dark .fv-lhead button:focus-visible{outline-color:#e8edf1}',
    '#fv-root.fv-dark .fv-in{background:#15191c;color:#e8edf1}#fv-root.fv-dark .fv-in:disabled{background:var(--grey);color:#71797f}',
    '#fv-root.fv-dark .fv-grid,#fv-root.fv-dark .fv-tree,#fv-root.fv-dark .fv-stack,#fv-root.fv-dark .fv-pick .rows{background:#1b1f23}',
    '#fv-root.fv-dark .fv-views button[aria-pressed="true"]{background:#23292e}',
    '#fv-root.fv-dark .fv-item.sel .fv-name,#fv-root.fv-dark .fv-item:focus-visible .fv-name{background:#3a6ea5;color:#fff}',
    '#fv-root.fv-dark .fv-grid.as-list .fv-item{border-bottom-color:rgba(255,255,255,.06)}',
    '#fv-root.fv-dark .fv-grid.as-list .fv-item.sel,#fv-root.fv-dark .fv-grid.as-list .fv-item:focus-visible,#fv-root.fv-dark .fv-ver.sel{background:#3a6ea5}',
    '#fv-root.fv-dark .fv-grid.as-list .fv-item span.dim,#fv-root.fv-dark .fv-ver .id,#fv-root.fv-dark .fv-ver.gap,#fv-root.fv-dark .fv-ver .size{color:#8a929a}',
    '#fv-root.fv-dark .fv-tw,#fv-root.fv-dark .fv-ver .when{color:#aeb9c2}',
    '#fv-root.fv-dark .fv-pick .where{color:#aeb9c2;background:#23292e}',
    '#fv-root.fv-dark .fv-pick .rows button{color:#d7dee4}#fv-root.fv-dark .fv-pick .rows button.dim{color:#71797f}#fv-root.fv-dark .fv-pick .rows p{color:#8a929a}',
    '#fv-root.fv-dark .fv-disk span{background:#23292e;color:#e8edf1}',
    '#fv-root.fv-dark .fv-disk.sel span,#fv-root.fv-dark .fv-disk:focus-visible span{background:#e8edf1;color:#000}',
    '#fv-root.fv-dark .fv-disk.home span{background:#6b5f2a;color:#f3ecc4}#fv-root.fv-dark .fv-disk.cross span{background:#2a4a6b;color:#cfe4ff}',
    '#fv-root.fv-dark .fv-disk.home.sel span,#fv-root.fv-dark .fv-disk.cross.sel span,#fv-root.fv-dark .fv-disk.home:focus-visible span,#fv-root.fv-dark .fv-disk.cross:focus-visible span{background:#e8edf1;color:#000}',
    '.fv-form p{margin:0;line-height:18px;user-select:text;-webkit-user-select:text}.fv-form code{font-family:var(--mono);font-size:12px}',
    '.fv-row{display:flex;align-items:center;gap:10px}.fv-row>label:first-child,.fv-row>b:first-child{width:92px;font-weight:700;flex:none}.fv-row .fv-in{flex:1;min-width:0}',
    '.fv-row.end{justify-content:flex-end;margin-top:auto}',
    /* browser */
    '.fv-bar{display:flex;align-items:center;gap:6px;padding:4px 6px;flex:none}.fv-bar .fv-in{flex:1;min-width:0;height:22px;font-size:12px}',
    '.fv-grid{flex:1;overflow:auto;background:#fff;padding:12px 8px;display:grid;grid-template-columns:repeat(auto-fill,minmax(112px,1fr));gap:14px 4px;align-content:start;',
    'border:2px solid;border-color:var(--dk) var(--lt) var(--lt) var(--dk)}',
    '.fv-item{display:flex;flex-direction:column;align-items:center;gap:2px;padding:2px;min-width:0;cursor:default}',
    '.fv-item span{font:11px/14px var(--mono);padding:0 3px;max-width:100%;overflow-wrap:anywhere;text-align:center}',
    '.fv-item.sys svg{opacity:.55}.fv-item.sel .fv-name,.fv-item:focus-visible .fv-name{background:#000;color:#fff}.fv-item:focus{outline:none}',
    '.fv-pic{position:relative;display:flex}',
    '.fv-badge{position:absolute;right:-1px;bottom:-1px;width:13px;height:13px;border-radius:50%;color:#fff;font:700 11px/1 var(--sans);display:flex;align-items:center;justify-content:center;box-shadow:0 0 0 1px var(--std);pointer-events:none}',
    '.fv-badge.exp{background:#1f7a34}.fv-badge.imp{background:#c0281f}.fv-badge.both{background:#6d3bb5}',
    '.fv-lock{position:absolute;left:-2px;top:-2px;width:14px;height:14px;border-radius:3px;background:#b8860b;color:#fff;display:flex;align-items:center;justify-content:center;box-shadow:0 0 0 1px var(--std);pointer-events:none}.fv-lock.held{background:#a01818}',
    '.fv-refresh{flex:none;width:24px;height:22px;padding:0;display:flex;align-items:center;justify-content:center;background:var(--grey);border:2px solid;border-color:var(--lt) var(--dk) var(--dk) var(--lt)}',
    '.fv-refresh:active{border-color:var(--dk) var(--lt) var(--lt) var(--dk)}.fv-refresh:focus-visible{outline:1px solid #000;outline-offset:1px}',
    '.fv-views{display:flex;flex:none}.fv-views button{width:24px;height:22px;padding:0;display:flex;align-items:center;justify-content:center;background:var(--grey);border:2px solid;border-color:var(--lt) var(--dk) var(--dk) var(--lt)}',
    '.fv-views button[aria-pressed="true"]{border-color:var(--dk) var(--lt) var(--lt) var(--dk);background:#e8e8e8}.fv-views button:focus-visible{outline:1px solid #000;outline-offset:1px}',
    '.fv-grid.as-list{display:block;padding:0}',
    '.fv-lhead,.fv-grid.as-list .fv-item{display:grid;grid-template-columns:minmax(180px,1fr) minmax(80px,150px) 126px 70px;align-items:center;column-gap:8px;padding:0 8px}',
    '.fv-grid.as-list .fv-nm{display:flex;align-items:center;gap:5px;min-width:0;overflow:visible}',
    '.fv-grid.as-list .fv-nm .fv-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:0 1 auto}',
    '.fv-tw{flex:none;width:18px;height:22px;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;font-size:15px;line-height:1;color:#333;user-select:none;-webkit-user-select:none}',
    '.fv-tw.leaf{visibility:hidden;cursor:default}.fv-grid.as-list .fv-item.sel .fv-tw{color:#fff}',
    '.fv-lhead{position:sticky;top:0;z-index:1;background:var(--grey);border-bottom:1px solid var(--dk);height:22px}',
    '.fv-lhead button{all:unset;box-sizing:border-box;font:700 11px var(--sans);color:#000;height:22px;line-height:22px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:default}',
    '.fv-lhead button:focus-visible{outline:1px solid #000;outline-offset:-2px}.fv-lhead .num,.fv-grid.as-list .fv-item .num{text-align:right}',
    '.fv-grid.as-list .fv-item{row-gap:0;height:22px;padding-top:0;padding-bottom:0;border-bottom:1px solid #eee}',
    '.fv-grid.as-list .fv-item span{font:12px/22px var(--mono);padding:0;max-width:none;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;overflow-wrap:normal}',
    '.fv-grid.as-list .fv-item span.dim{color:#555}',
    '.fv-grid.as-list .fv-item.sel,.fv-grid.as-list .fv-item:focus-visible{background:#000}.fv-grid.as-list .fv-item.sel span,.fv-grid.as-list .fv-item:focus-visible span{background:none;color:#fff}',
    '.fv-grid.as-list .fv-item.sel svg,.fv-grid.as-list .fv-item:focus-visible svg{filter:invert(1)}',
    /* versions */
    '.fv-vers{flex:1;min-height:0;display:flex;flex-direction:column;gap:6px;padding:6px}.fv-vers .foot{display:flex;align-items:center;gap:6px}.fv-vers .foot p{flex:1;margin:0;font:12px var(--sans)}.fv-vers .foot p.bad{color:#a00010;font-weight:700}',
    '.fv-tree{flex:1;overflow:auto;background:#fff;padding:4px 0;outline:none;border:2px solid;border-color:var(--dk) var(--lt) var(--lt) var(--dk)}',
    '.fv-ver{display:flex;align-items:center;gap:8px;padding:0 8px;height:22px;font:12px/22px var(--mono);white-space:pre}.fv-ver.gap{color:#555;justify-content:center;font-family:var(--sans)}',
    '.fv-ver .guide{color:#777;margin-right:-8px}.fv-ver .dot{width:9px;height:9px;border-radius:50%;border:1px solid #000;background:#fff;flex:none}.fv-ver .dot.on{background:#1faa4a}',
    '.fv-ver .when{min-width:150px}.fv-ver .size{min-width:60px;text-align:right;color:#444}.fv-ver .id{color:#666}.fv-ver em{font:700 10px var(--sans);font-style:normal;padding:0 4px;background:#000;color:#fff;line-height:14px}.fv-ver em.fork{background:#666}',
    '.fv-ver.sel{background:#000;color:#fff}.fv-ver.sel .size,.fv-ver.sel .id,.fv-ver.sel .guide{color:#ddd}.fv-ver.sel em{background:#fff;color:#000}',
    /* defining exports and imports */
    '.fv-def{flex:1;min-height:0;display:grid;grid-template-columns:250px minmax(0,1fr);grid-template-rows:minmax(0,1fr) auto;gap:6px;padding:6px}',
    '.fv-def h5{margin:0 0 4px;font:700 12px var(--sans)}.fv-def .side{display:flex;flex-direction:column;min-height:0}',
    '.fv-stack{flex:1;overflow-x:auto;overflow-y:scroll;background:#fff;padding:3px;display:flex;flex-direction:column;gap:3px;border:2px solid;border-color:var(--dk) var(--lt) var(--lt) var(--dk)}',
    '.fv-layer{display:grid;grid-template-columns:14px minmax(0,1fr) auto;align-items:center;column-gap:6px;padding:4px 6px;background:var(--grey);text-align:left;font:12px var(--sans);color:#000;border:2px solid;border-color:var(--lt) var(--dk) var(--dk) var(--lt)}',
    '.fv-layer.sel{background:var(--hi)}.fv-layer:focus-visible{outline:1px solid #000;outline-offset:1px}.fv-layer.self{background:#d9d2b8}.fv-layer.self.sel{background:var(--hi)}',
    '.fv-layer b{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.fv-layer small{display:block;font:11px var(--mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.fv-layer em{font:700 10px var(--sans);font-style:normal;padding:0 4px;background:#000;color:#fff}',
    '.fv-lamp{width:10px;height:10px;border-radius:50%;border:1px solid #000;background:#8a8a8a}.fv-lamp.ok{background:#1faa4a}.fv-lamp.bad{background:#d0202c}.fv-lamp.warn{background:#e8b800}.fv-lamp.new{background:#fff}',
    '.fv-ground{font:11px var(--sans);text-align:center;color:#333;padding:2px}',
    '.fv-def .tools{display:flex;flex-wrap:nowrap;gap:3px;margin-top:5px}.fv-def .tools .fv-btn{padding:0 6px;white-space:nowrap;flex:0 0 auto}',
    '.fv-entry{overflow-x:auto;overflow-y:scroll;background:var(--grey);padding:8px 10px;display:flex;flex-direction:column;gap:7px;border:2px solid;border-color:var(--dk) var(--lt) var(--lt) var(--dk)}',
    '.fv-entry h6{margin:6px 0 0;font:700 12px var(--sans);border-bottom:1px solid var(--dk);padding-bottom:2px}',
    '.fv-f{display:grid;grid-template-columns:170px minmax(0,1fr);column-gap:8px;align-items:start}.fv-f>label,.fv-f>b{font:12px var(--mono);padding-top:5px;overflow-wrap:anywhere}.fv-f>label.req:after{content:" *";font-weight:700}',
    '.fv-f .fv-in,.fv-f select,.fv-f textarea{width:100%;font:12px var(--mono)}.fv-f textarea{min-height:44px;resize:vertical;padding:3px 6px;background:#fff;border:2px solid;border-color:var(--dk) var(--lt) var(--lt) var(--dk);user-select:text;-webkit-user-select:text}',
    '.fv-f select{height:26px;background:#fff;border:2px solid;border-color:var(--dk) var(--lt) var(--lt) var(--dk)}',
    '.fv-f .bad{outline:2px solid #d0202c}.fv-f small{grid-column:2;font:11px/14px var(--sans);color:#333;user-select:text;-webkit-user-select:text}',
    '.fv-f .checks{display:flex;flex-wrap:wrap;gap:2px 12px;padding-top:4px;font:12px var(--mono)}.fv-f .checks label{display:flex;align-items:center;gap:4px}',
    '.fv-f output{font:12px var(--mono);padding-top:5px;overflow-wrap:anywhere;user-select:text;-webkit-user-select:text}',
    '.fv-def .foot{grid-column:1/-1;display:flex;align-items:center;gap:6px}.fv-def .foot p{flex:1;margin:0;font:12px var(--sans);user-select:text;-webkit-user-select:text}.fv-def .foot p.bad{color:#a00010;font-weight:700}',
    '.fv-note{grid-column:1/-1;padding:18px;text-align:center;color:#333;line-height:19px;user-select:text;-webkit-user-select:text}',
    '.fv-status{flex:none;font:11px/16px var(--mono);padding:2px 6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border:1px solid;border-color:var(--lt) var(--dk) var(--dk) var(--lt)}',
    '.fv-text{flex:1;margin:0;overflow:auto;background:#fff;padding:8px 10px;font:12px/17px var(--mono);white-space:pre-wrap;overflow-wrap:anywhere;user-select:text;-webkit-user-select:text;',
    'border:2px solid;border-color:var(--dk) var(--lt) var(--lt) var(--dk)}',
    '.fv-text.hex{white-space:pre}',
    '.fv-img{flex:1;overflow:auto;background:#fff repeating-conic-gradient(#ddd 0% 25%,#fff 0% 50%) 0 0/16px 16px;display:flex;align-items:center;justify-content:center;',
    'border:2px solid;border-color:var(--dk) var(--lt) var(--lt) var(--dk)}.fv-img img{max-width:100%;max-height:100%;image-rendering:pixelated}'
  ].join('\n');

  /* ------------------------------------------------------------------ CDMI client */

  var CD = {
    origin: CFG.origin,
    fetch: loggedFetch('desktop', function (u, o) { return window.fetch(u, o); }),
    auth: null,              // value of the Authorization header, once the user has signed in
    caps: null,              // capabilities read from the discovery tree
    listMode: {}             // base URI -> 'plain' once its server has refused an extended listing as such
  };

  /* TLS only. Every URI the desktop connects to is https:, whether it was discovered, typed, stored or
     arrived at through a redirect. */
  function isTLS(u) { try { return new URL(u, CD.origin + '/').protocol === 'https:'; } catch (e) { return false; } }
  function requireTLS(u) { if (!isTLS(u)) throw new CdmiError(0, 'Refused: ' + String(u).split('?')[0] + ' is not an https: URI, and this desktop only connects over TLS.', u); }
  function checkLanding(res, url) { if (res.url && !isTLS(res.url)) throw new CdmiError(0, 'Refused: ' + url + ' redirected to a URI that is not https:.', res.url); return res; }

  function sameOrigin(u) { try { return new URL(u, CD.origin + '/').origin === new URL(CD.origin + '/').origin; } catch (e) { return false; } }

  async function toError(res) {
    var msg = res.status + ' ' + (res.statusText || ''), body = null;
    try { body = await res.clone().json(); } catch (e) { /* not JSON */ }
    if (body && (body.title || body.detail)) msg = res.status + ' ' + [body.title, body.detail].filter(Boolean).join(': ');
    return new CdmiError(res.status, msg.trim(), res.url);
  }

  var signInPending = null;
  async function req(url, accept, opts) {
    opts = opts || {};
    requireTLS(url);
    var headers = { Accept: accept };
    if (CD.auth && (sameOrigin(url) || vouchedOrigins[originOf(url)])) headers.Authorization = CD.auth;
    var res = checkLanding(await CD.fetch(url, { method: 'GET', headers: headers, redirect: 'follow', credentials: 'same-origin', cache: 'no-store', fvQuiet: !!(opts.quiet || opts.probe) }), url);      // an expected miss is filed under Debug in the log
    if (res.status === 401 && !opts.quiet && !opts.retried) {
      if (!signInPending) signInPending = signInDialog('The server asked for authentication.').finally(function () { signInPending = null; });
      if (await signInPending) return req(url, accept, { retried: true });
    }
    return res;
  }

  async function getRep(url, accept, opts) {
    var res = await req(url, accept, opts);
    if (!res.ok) throw await toError(res);
    var ct = (res.headers.get('content-type') || '').toLowerCase();
    var out = { url: stripQuery(res.url || url), contentType: ct };
    if (/^application\/(cdmi-|json)/.test(ct)) out.rep = await res.json();
    else { out.raw = await res.blob(); out.rep = { objectType: T_OBJECT, mimetype: ct.split(';')[0] || 'application/octet-stream' }; }
    return out;
  }

  async function send(method, url, type, body, extra, retried) {
    requireTLS(url);
    var headers = Object.assign({ 'Content-Type': type, Accept: type }, extra || {});
    if (CD.auth && (sameOrigin(url) || vouchedOrigins[originOf(url)])) headers.Authorization = CD.auth;
    var res = checkLanding(await CD.fetch(url, { method: method, headers: headers, body: body, redirect: 'follow', credentials: 'same-origin' }), url);
    if (res.status === 401 && !retried) {
      if (!signInPending) signInPending = signInDialog('The server asked for authentication.').finally(function () { signInPending = null; });
      if (await signInPending) return send(method, url, type, body, extra, true);
    }
    return res;
  }

  function bytesB64(bytes) { var s = ''; for (var i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); }

  /* Create a data object from a File. The value travels inside the representation: as a UTF-8 string
     where the file is text, as base64 otherwise. If-None-Match: * makes the server refuse (412) rather
     than replace an object of the same name. Returns 'created', 'replaced' or 'exists'. */
  async function uploadInto(containerURL, file, name, replace) {
    name = String(name).replace(/[\/?]/g, '_'); var bytes = new Uint8Array(await file.arrayBuffer());     // "/" and "?" are reserved in object names
    var mime = file.type || 'application/octet-stream', rep = { mimetype: mime, metadata: {} }, text = null;
    if (isTextual(mime)) { try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch (e) { text = null; } }
    if (text !== null) { rep.valuetransferencoding = 'utf-8'; rep.value = text; } else { rep.valuetransferencoding = 'base64'; rep.value = bytesB64(bytes); }
    var res = await send('PUT', containerURL + enc(name), T_OBJECT, JSON.stringify(rep), replace ? {} : { 'If-None-Match': '*' });
    if (res.status === 412 && !replace) return 'exists';
    if (!res.ok) throw await toError(res);
    delete appCache[containerURL]; delete iconCache[containerURL]; delete iconKnown[containerURL];
    return replace ? 'replaced' : 'created';
  }
  function uploadFile(containerURL, file, replace) { return uploadInto(containerURL, file, file.name, replace); }

  // Create the chain of subcontainers a dropped folder needs, so its contents can be written beneath it. `made`
  // memoizes the levels created or confirmed this drop, so each is PUT once; a 412 means it already exists -- fine.
  async function ensurePath(baseURL, segs, made) {
    var cur = baseURL;
    for (var i = 0; i < segs.length; i++) {
      cur += enc(segs[i]) + '/';
      if (!made[cur]) {
        var res = await send('PUT', cur, T_CONTAINER, JSON.stringify({ metadata: {} }), { 'If-None-Match': '*' });
        if (!(res.ok || res.status === 412)) throw await toError(res);
        made[cur] = 1; delete appCache[cur]; delete iconCache[cur]; delete iconKnown[cur];
      }
    }
    return cur;
  }

  // Upload a dropped set into a container. Each entry is { file, path } for a file or { dir:true, path } for a folder;
  // `path` is relative to the container, so a folder dragged in with its contents carries the subcontainer names it
  // needs, which are created on the way. Plain files have path === their name (no subcontainers).
  async function uploadFiles(containerURL, entries, progress) {
    var done = [], made = {};
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i], segs = e.path.split('/').filter(Boolean), outcome;
      if (progress) progress('Uploading ' + e.path + ' (' + (i + 1) + ' of ' + entries.length + ') \u2026');
      try {
        if (e.dir) { await ensurePath(containerURL, segs, made); outcome = 'created'; }
        else {
          var nm = segs.pop(), dir = await ensurePath(containerURL, segs, made);
          outcome = await uploadInto(dir, e.file, nm, false);
          if (outcome === 'exists') outcome = (await confirmBox('Replace?', e.path + ' already exists in this container. Replace it?', 'Replace', 'Skip')) ? await uploadInto(dir, e.file, nm, true) : 'skipped';
        }
      } catch (err) { outcome = 'failed: ' + err.message; }
      done.push({ name: e.path, size: e.file ? e.file.size : 0, outcome: outcome });
    }
    return done;
  }

  /* ---- moving and copying objects by dragging them

     dragging holds what was picked up, because a page may not read a drag's data until it is dropped. */
  var DRAG_TYPE = 'application/x-cdmi-object', dragging = null, browsers = [];
  var dropPanes = {};               // app id -> { frame, pane, w } : the app's native drop pane (before a document loads)
  // Shows a native drop pane as the window's content, in place of the (still hidden) iframe. handlers.onFile(file)
  // receives a host file; handlers.onObject(url) receives a cvwm object's URL. The pane is a real desktop element,
  // so both kinds of drop land on it reliably, which the iframe could not do for an internal cvwm drag.
  // Clears the page-wide drag state (the class that suppresses iframe pointer events while a file is dragged over the
  // page). The pane's drop stops propagation, so the window handler that normally clears it does not run.
  function clearDragState() {
    root.classList.remove('fv-dragging');
    WM.wins.forEach(function (w) { w.el.classList.remove('fv-over'); });
    document.querySelectorAll('.fv-into,.fv-over,.fv-open').forEach(function (n) { n.classList.remove('fv-into', 'fv-over', 'fv-open'); });
  }
  function showDropPane(id, handlers) {
    var slot = dropPanes[id]; if (!slot) return;
    if (slot.pane) slot.pane.remove();
      var openBtn = handlers.onOpen ? h('button', { class: 'fv-btn', type: 'button', text: handlers.openLabel || 'Open\u2026' }) : null;
    if (openBtn) openBtn.addEventListener('click', function () { try { handlers.onOpen(); } catch (e) { console.error(e); } });
    var msg = h('div', { class: 'fv-droppane-msg' }, [
      h('div', { class: 'fv-droppane-icon', html: icon('object', 40) }),
      h('p', { html: (handlers.label || 'Open a file') + '<br><span>drop a file here, or a cvwm object from a container</span>' }),
      openBtn ]);
    var pane = h('div', { class: 'fv-droppane' }, [msg]);
    slot.frame.style.display = 'none';
    slot.w.client.insertBefore(pane, slot.w.client.firstChild);
    slot.pane = pane; slot.w.dropPaneActive = true;
    function accept(ev) { ev.preventDefault(); ev.stopPropagation(); ev.fvSeen = true; if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy'; pane.classList.add('over'); }
    pane.addEventListener('dragenter', accept);
    pane.addEventListener('dragover', accept);
    pane.addEventListener('dragleave', function (ev) { if (ev.target === pane) pane.classList.remove('over'); });
    pane.addEventListener('drop', function (ev) {
      ev.preventDefault(); ev.stopPropagation(); pane.classList.remove('over');
      clearDragState();                                // the window 'drop' handler is stopped above, so clear here:
      var dt = ev.dataTransfer; if (!dt) return;       // otherwise fv-dragging stays and iframes lose pointer events
      if (dt.files && dt.files.length && handlers.onFile) { handlers.onFile(dt.files[0]); return; }
      var url = objectURLFromDrop(dt);
      if (url && handlers.onObject) handlers.onObject(url);
    });
  }
  // Swaps from the drop pane to the iframe once the app has a document to show; the pane stops being a drop target.
  function showApp(id) {
    var slot = dropPanes[id]; if (!slot) return;
    if (slot.pane) { slot.pane.remove(); slot.pane = null; }
    slot.w.dropPaneActive = false;
    slot.frame.style.display = '';
  }
  function isInternal(ev) { var t = ev.dataTransfer && ev.dataTransfer.types; return !!dragging && !!t && Array.prototype.indexOf.call(t, DRAG_TYPE) >= 0; }
  function isDraggingObject() { return !!dragging && dragging.kind === 'object'; }      // a data object is being dragged (a container is not opened by mdviewer et al.)
  function objectURLFromDrop(dt) {
    if (dragging && dragging.url) return dragging.url;                                   // the live drag (same document)
    try { var j = dt.getData(DRAG_TYPE); if (j) { var o = JSON.parse(j); return o.url || null; } } catch (e) { /* not our payload */ }
    var u = dt.getData('text/uri-list') || dt.getData('text/plain'); return u ? u.trim().split(/\s+/)[0] : null;
  }
  function wantsCopy(ev) { return ev.ctrlKey || ev.altKey; }
  function isReserved(name, parentURL) { var bare = name.replace(/[\/?]$/, ''), d = diskFor(parentURL); return /^cdmi_/.test(bare) && (bare === 'cdmi_snapshots' || (!!d && parentURL === d.base)); }
  function parentOf(url) { return url.replace(/[^\/]+\/?$/, ''); }
  /* May src be dropped into the container at `to`? Not into itself or beneath itself, and a move into the
     container it is already in would do nothing. */
  function canDrop(src, to, copy) {
    if (!src || !to) return false;
    if (src.kind === 'container' && to.indexOf(src.url) === 0) return false;
    return copy || to !== src.parent;
  }
  function nameForCopy(name) { var m = /^(.*?)(\.[^.]*)?$/.exec(name); return m[1] + ' copy' + (m[2] || ''); }

  async function transfer(src, to, copy, progress) {
    var verb = copy ? 'copy' : 'move', bare = src.name.replace(/[\/?]$/, '');
    try {
      var kind = src.kind;
      if (kind === 'object' && !src.type) { try { kind = (await getLeaf(src.url + '?objectType')).rep.objectType === T_QUEUE ? 'queue' : 'object'; } catch (e) { /* the server will say */ } }
      var name = copy && to === src.parent ? nameForCopy(bare) : bare, dest = to + enc(name) + (kind === 'container' ? '/' : '');
      var type = kind === 'container' ? T_CONTAINER : kind === 'queue' ? T_QUEUE : T_OBJECT;
      if (progress) progress((copy ? 'Copying ' : 'Moving ') + bare + ' \u2026');
      /* Is the name taken? Asked first, because a server may not honour If-None-Match on a copy or a move. */
      var there = await req(dest + '?objectName', kind === 'reference' ? T_OBJECT : type, { quiet: true });
      if (there.ok || (there.status === 406 && kind !== 'container')) {
        // Replacing an existing object deletes it, which retention or hold forbids. Check the target and explain,
        // rather than offering a Replace that the server will refuse. (A move preserves the source and its retention,
        // so the source is not the concern; the object being overwritten is.)
        var tl = await probeLock(dest).catch(function () { return null; });
        if (tl && tl.restricted) {
          var twhy = tl.held && tl.retained ? 'it is retained and under ' + tl.holds.length + (tl.holds.length === 1 ? ' hold' : ' holds')
            : tl.held ? 'it is under ' + tl.holds.length + (tl.holds.length === 1 ? ' hold' : ' holds')
            : 'it is retained' + (tl.retainedUntil ? ' until ' + new Date(tl.retainedUntil).toISOString() : '');
          messageBox('Cannot ' + verb + ' onto ' + name, name + ' already exists there and cannot be replaced because ' + twhy + ' \u2014 replacing it would delete it, which retention and hold forbid. A retention period ends on its own; a hold is released outside CDMI.');
          return false;
        }
        if (kind === 'container') { messageBox('Cannot ' + verb, 'A container named ' + name + ' is already there.'); return false; }
        if (!(await confirmBox('Replace?', name + ' already exists there. Replace it?', 'Replace', 'Cancel'))) return false;
      }
      /* The source is named by its absolute URI. The server resolves a URI within its own base URIs to a local
         copy, and one at another origin to a remote copy; both are accepted. A disk-relative path (pathIn) would
         carry the "~/" home shorthand, which is a display convention, not a namespace path the server accepts. */
      var body = {};
      body[verb] = src.url;
      var res = await send('PUT', dest, type, JSON.stringify(body));
      if (!res.ok) throw await toError(res);
      [src.parent, to, src.url].forEach(function (u) { delete appCache[u]; delete iconCache[u]; delete iconKnown[u]; });
      browsers.forEach(function (b) { if (!b.win.closed && (b.url === to || b.url === src.parent)) b.show(b.url); });
      return true;
    } catch (e) { messageBox('Cannot ' + verb + ' ' + bare, e.message); return false; }
  }

  /* Make an element a place to drop things into the container at url(): files from the host, or objects. */
  function acceptDrops(el, url, progress) {
    function over(ev) {
      var files = hasFiles(ev), inner = isInternal(ev); if (!files && !inner) return;
      var to = url(), ok = !!to && (files || canDrop(dragging, to, wantsCopy(ev)));
      ev.preventDefault(); ev.stopPropagation(); ev.fvSeen = true;
      ev.dataTransfer.dropEffect = !ok ? 'none' : files || wantsCopy(ev) ? 'copy' : 'move';
      el.classList.toggle('fv-into', ok);
      WM.wins.forEach(function (w) { w.el.classList.remove('fv-over'); });
    }
    el.addEventListener('dragenter', over); el.addEventListener('dragover', over);
    el.addEventListener('dragleave', function () { el.classList.remove('fv-into'); });
    el.addEventListener('drop', async function (ev) {
      var files = hasFiles(ev), inner = isInternal(ev); if (!files && !inner) return;
      ev.preventDefault(); ev.stopPropagation(); el.classList.remove('fv-into');
      var to = url(); if (!to) return;
      if (inner) { var src = dragging, copy = wantsCopy(ev); if (canDrop(src, to, copy)) await transfer(src, to, copy, progress); return; }
      var col = collectDrop(ev.dataTransfer), results = await uploadFiles(to, await expandDrop(col), progress);
      browsers.forEach(function (b) { if (!b.win.closed && (b.url === to || b.url === parentOf(to))) b.show(b.url); });
      var bad = results.filter(function (r) { return /^failed/.test(r.outcome); });
      if (bad.length) messageBox('Upload', bad.map(function (r) { return r.name + ' \u2014 ' + r.outcome; }).join('\n'));
    });
  }

  // Dropping a cvwm object onto an application opens it: the app is run with the object as its start. getAppURL()
  // returns the app's container URL while the element is known to be an app, else null (then this does nothing and the
  // element's acceptDrops, if any, handles the drop instead). Host files are not CDMI objects, so they are ignored
  // here. The app decides whether it can open the object -- there is no type check; it rejects on its own, as it must
  // for any open.
  function acceptAppOpen(el, getAppURL, progress) {
    function over(ev) {
      if (!isInternal(ev)) return;                          // only an object dragged within cvwm opens in an app
      var app = getAppURL(); if (!app || (dragging && dragging.url === app)) return;   // not an app now, or onto itself
      ev.preventDefault(); ev.stopPropagation(); ev.fvSeen = true;
      ev.dataTransfer.dropEffect = 'copy';
      el.classList.add('fv-open');
      WM.wins.forEach(function (w) { w.el.classList.remove('fv-over'); });
    }
    el.addEventListener('dragenter', over); el.addEventListener('dragover', over);
    el.addEventListener('dragleave', function () { el.classList.remove('fv-open'); });
    el.addEventListener('drop', function (ev) {
      if (!isInternal(ev)) return;
      var app = getAppURL(); if (!app || (dragging && dragging.url === app)) return;
      ev.preventDefault(); ev.stopPropagation(); el.classList.remove('fv-open');
      var obj = dragging && dragging.url;
      if (obj) { launchApp(app, { start: obj }); if (progress) progress('Opening ' + safeDecode(obj.replace(/\/$/, '').split('/').pop()) + ' …'); }
    });
  }

  // A drop's DataTransfer is only valid during the event, so collect it synchronously: the folder/file ENTRIES where the
  // browser offers them (webkitGetAsEntry -- these persist and can be walked after the event), else a snapshot of the
  // plain files. expandDrop then walks folders and their contents asynchronously.
  function collectDrop(dt) {
    var items = dt.items, roots = [];
    if (items && items.length && items[0].webkitGetAsEntry) {
      for (var i = 0; i < items.length; i++) { var en = items[i].webkitGetAsEntry(); if (en) roots.push(en); }
      if (roots.length) return { roots: roots };
    }
    return { files: Array.prototype.slice.call(dt.files || []) };
  }
  async function expandDrop(col) {
    if (!col.roots) return (col.files || []).map(function (f) { return { file: f, path: f.name }; });
    var out = [];
    for (var i = 0; i < col.roots.length; i++) await walkEntry(col.roots[i], '', out);
    return out;
  }
  // Walk a FileSystemEntry into { file, path } for each file, recording the relative path (folder names included). An
  // empty folder is emitted as { dir:true, path } so it is still created.
  async function walkEntry(entry, prefix, out) {
    if (entry.isFile) {
      var file = await new Promise(function (res, rej) { entry.file(res, rej); });
      out.push({ file: file, path: prefix + file.name });
    } else if (entry.isDirectory) {
      var reader = entry.createReader(), all = [], batch;
      do { batch = await new Promise(function (res, rej) { reader.readEntries(res, rej); }); all = all.concat(Array.prototype.slice.call(batch)); } while (batch.length);   // readEntries returns in batches
      var here = prefix + entry.name + '/';
      if (!all.length) { out.push({ dir: true, path: here }); return; }
      for (var i = 0; i < all.length; i++) await walkEntry(all[i], here, out);
    }
  }
  function hasFiles(ev) { var t = ev.dataTransfer && ev.dataTransfer.types; return !!t && Array.prototype.indexOf.call(t, 'Files') >= 0; }

  function getLeaf(url, opts) { return getRep(url, ACCEPT_LEAF, opts); }
  function readObject(url, opts) { return getRep(stripQuery(url) + VALUE_FIELDS, T_OBJECT, opts); }

  function childKind(name, type) {
    if (/\?$/.test(name)) return 'reference';
    if (/\/$/.test(name)) return 'container';
    return type === T_QUEUE ? 'queue' : 'object';
  }
  /* fields: the names asked for in childfields, in order, or null for a plain listing. */
  function normChildren(list, fields) {
    var out = [], at = {}; (fields || []).forEach(function (f, i) { at[f] = i; });
    (list || []).forEach(function (c) {
      if (fields && Array.isArray(c)) {
        var name = c[at.objectName], md = at.metadata === undefined ? null : c[at.metadata], inside = at.children === undefined ? null : c[at.children];
        if (typeof name !== 'string') return;
        out.push({ name: name, type: c[at.objectType] || null, kind: childKind(name, c[at.objectType]), inside: Array.isArray(inside) ? inside.filter(function (n) { return typeof n === 'string'; }) : null,
          mime: at.mimetype !== undefined && typeof c[at.mimetype] === 'string' ? c[at.mimetype] : null, modified: md && md.cdmi_mtime ? String(md.cdmi_mtime) : null,
          size: md && md.cdmi_size !== undefined && md.cdmi_size !== null && isFinite(+md.cdmi_size) ? +md.cdmi_size : null, detailed: !!md,
          versioned: !!(md && (md.cdmi_version_current || (md.cdmi_version_oldest && md.cdmi_version_oldest.length) || md.cdmi_versioning)),   // cdmi_versioning alone is enough: a listing may omit the chain items a full read carries
          locked: md ? restrictionFromMeta(md) : null });
      } else if (typeof c === 'string') out.push({ name: c, type: null, kind: childKind(c, null), inside: null, mime: null, modified: null, size: null, detailed: false, versioned: false });
    });
    return out;
  }
  function childURL(containerURL, name) {
    var bare = name.replace(/[\/?]$/, '');
    return containerURL + enc(bare) + (/\/$/.test(name) ? '/' : '');
  }

  /* Read a container and enumerate its children, paging with children=<range>. One extended listing,
     childfields=objectType;objectName;children, gives each child's type and its own child list, which is how the
     browser learns which child containers hold index.js and index.png without a request per child.

     Where that is refused the container is read plainly: types then come from the form of each name, and
     applications are found by probing. A 400 means the server does not understand the selection, and is remembered
     for its base URI; a 501 means this one object does not offer it (a capability object does not), and is not.

     detailed: also ask for each child's media type and metadata (size, time of modification), for the list view. */
  function refused(e) { return e instanceof CdmiError && (e.status === 400 || e.status === 501); }

  async function listContainer(url, baseKey, detailed) {
    var page = CFG.pageSize, head = '?objectType&objectName&objectID&parentURI&capabilitiesURI&metadata&exports&imports&childrenrange&children=0-';
    if (CD.listMode[baseKey] !== 'plain') {
      try {
        var names = ['objectType', 'objectName', 'children'].concat(detailed ? ['mimetype', 'metadata'] : []), fields = '&childfields=' + names.join(';');
        var first = await getRep(url + head + (page - 1) + fields, ACCEPT_DIR, { probe: true });
        var got = (first.rep.children || []).length, from = got, truncated = false, kids = normChildren(first.rep.children, names);
        while (got === page) {
          if (kids.length >= CFG.maxChildren) { truncated = true; break; }
          var more = await getRep(url + '?childrenrange&children=' + from + '-' + (from + page - 1) + fields, ACCEPT_DIR);
          got = (more.rep.children || []).length; kids = kids.concat(normChildren(more.rep.children, names)); from += got;
        }
        if (kids.length > page) first.rep.childrenrange = '0-' + (kids.length - 1);       // the range of everything we gathered
        return { url: first.url, rep: first.rep, children: kids, truncated: truncated, detailed: !!detailed };
      } catch (e) { if (!refused(e)) throw e; if (e.status === 400) CD.listMode[baseKey] = 'plain'; }
    }
    var plain = await getRep(url, ACCEPT_DIR);
    return { url: plain.url, rep: plain.rep, children: normChildren(plain.rep.children, null), truncated: false, detailed: false };
  }

  function b64bytes(s) { var bin = atob(String(s).replace(/\s+/g, '')), a = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return a; }

  async function readValue(got) {
    var rep = got.rep, mime = rep.mimetype || 'application/octet-stream';
    if (got.raw) return { mime: mime, bytes: new Uint8Array(await got.raw.arrayBuffer()) };
    var e = rep.valuetransferencoding;
    if (e === 'json') return { mime: 'application/json', text: JSON.stringify(rep.value, null, 2) };
    if (e === 'base64') return { mime: mime, bytes: b64bytes(rep.value || '') };
    return { mime: mime, text: rep.value === undefined ? '' : String(rep.value) };
  }
  function isTextual(mime) { return /^text\/|json|xml|javascript|ecmascript|x-sh|yaml|csv/.test(mime); }
  function bytesToText(b) { return new TextDecoder('utf-8').decode(b); }

  async function readCapabilities() {
    try { CD.caps = (await getRep(CD.origin + WELL_KNOWN + 'cdmi_capabilities/', T_CAPABILITY, { quiet: true })).rep.capabilities || {}; }
    catch (e) { CD.caps = null; }
    return CD.caps;
  }

  /* Returns null where the origin serves no discovery tree (404), else [{name, base, locked}]. */
  async function discover() {
    var treeURL = CD.origin + WELL_KNOWN + 'cdmi_namespaces/', out = [];
    function admit(name, base) {
      // A base URI is mounted where it is https and at this origin (the spec has cvwm mount only same-origin bases).
      var abs; try { abs = new URL(stripQuery(base), treeURL).href; } catch (e) { console.warn('[cdmi] ' + name + ': base URI is not a URI: ' + base); return; }
      if (!/\/$/.test(abs)) abs += '/';
      if (!isTLS(abs)) { console.warn('[cdmi] ' + name + ': base URI is not https: and is ignored: ' + abs); return; }
      if (!sameOrigin(abs)) { console.warn('[cdmi] ' + name + ': base URI at another origin ignored, as the spec requires: ' + abs); return; }
      // The locked state is not probed here; first access determines it (a 401/403 opening a disk marks it locked,
      // a successful read unlocks it -- see Browser.show). The "home" reference is the signed-in principal's (HOMES.md).
      out.push({ name: name, base: abs, locked: false, home: name === HOME_NAME });
    }
    // One extended listing gives every reference's destination in the `location` field (revision 297), so the base
    // URIs are read without a GET per reference. seedmi answers this; following each 307 (below) is the fallback for a
    // server that does not, and it can also fail cross-origin or on a destination the browser cannot reach.
    try {
      var ex = await req(treeURL + '?childfields=objectName;location', T_CONTAINER, { quiet: true, probe: true });
      if (ex.status === 404) return null;
      if (ex.ok) {
        var kids = ((await ex.json()).children) || [];
        if (kids.length && Array.isArray(kids[0])) {                      // the extended form: [objectName, location] per child
          kids.forEach(function (c) {
            var name = (c[0] || '').replace(/[\/?]$/, ''), loc = c[1];
            if (!name) return;
            if (typeof loc !== 'string' || !loc) { console.warn('[cdmi] ' + name + ': reference names no base URI'); return; }
            admit(name, loc);
          });
          return out;
        }
      }
    } catch (e) { /* fall through to the plain listing and follow each reference */ }
    // Fallback: the server did not answer the extended listing. Read the names, then follow each reference's 307 once.
    var res = await req(treeURL, T_CONTAINER, { quiet: true });
    if (res.status === 404) return null;
    if (!res.ok) throw await toError(res);
    var names = normChildren((await res.json()).children, false);
    for (var i = 0; i < names.length; i++) {
      var name = names[i].name.replace(/[\/?]$/, '');
      try {
        // A reference answers 307; fetch() hides Location, so follow it and read where we landed.
        var r = await req(treeURL + enc(name), T_CONTAINER, { quiet: true });
        var landed = stripQuery(r.url || '');
        if (!landed || landed === treeURL + enc(name) || !/\/$/.test(landed)) { console.warn('[cdmi] ' + name + ': reference did not lead to a base URI'); continue; }
        if (!isTLS(landed)) { console.warn('[cdmi] ' + name + ': base URI is not https: and is ignored: ' + landed); continue; }
        if (!sameOrigin(landed)) { console.warn('[cdmi] ' + name + ': base URI at another origin ignored, as the spec requires: ' + landed); continue; }
        out.push({ name: name, base: landed, locked: r.status === 401 || r.status === 403, home: name === HOME_NAME });
      } catch (e) { console.warn('[cdmi] ' + name + ': not mounted. ' + (e instanceof CdmiError ? e.message : 'The reference led somewhere the browser would not follow (an http: URI, or another origin).')); }
    }
    return out;
  }

  /* ------------------------------------------------------------------ window manager */

  var root, view, shield, disksEl, iconsEl, pagerEl;
  var WM = { wins: [], focused: null, z: 10, desk: [0, 0], cascade: 0 };
  var winUid = 0;                 // a stable id per window (every Win, not only app iframes), for the capture app

  function vw() { return root.clientWidth; }
  function vh() { return root.clientHeight; }

  function dragSession(ev, cursor, onMove, onEnd) {
    if (ev.button !== undefined && ev.button !== 0) return;
    ev.preventDefault();
    var sx = ev.clientX, sy = ev.clientY;
    shield.style.display = 'block'; shield.style.cursor = cursor;
    function move(e) { onMove(e.clientX - sx, e.clientY - sy, e); }
    function up(e) {
      window.removeEventListener('pointermove', move, true); window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
      shield.style.display = 'none'; if (onEnd) onEnd(e); changed();
    }
    window.addEventListener('pointermove', move, true); window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
  }

  function Win(o) {
    var self = this;
    this.title = o.title || 'untitled'; this.iconName = o.icon || 'object';
    this.minW = o.minW || 200; this.minH = o.minH || 110; this.onClose = o.onClose;
    this.w = Math.min(o.w || 520, vw() - 20); this.h = Math.min(o.h || 340, vh() - 20);
    this.dx = WM.desk[0]; this.dy = WM.desk[1];
    if (o.center) { this.x = Math.round((vw() - this.w) / 2); this.y = Math.round((vh() - this.h) / 3); }
    else { var c = WM.cascade++ % 8; this.x = 60 + c * 28; this.y = 40 + c * 26; }
    this.x = clamp(this.x, 0, Math.max(0, vw() - this.w)); this.y = clamp(this.y, 0, Math.max(0, vh() - this.h));
    this.iconified = false; this.maxed = null; this.aspect = 0; this.before = WM.focused;       // a dialog gives focus back to the window it interrupted

    this.tt = h('div', { class: 'fv-tt', text: this.title });
    this.dropLabel = h('span', { text: '' });
    this.client = h('div', { class: 'fv-client' }, [o.content, h('div', { class: 'fv-drop' }, [this.dropLabel])]);
    var bMenu = h('button', { class: 'fv-tb m', type: 'button', 'aria-label': 'Window menu', title: 'Window menu (double-click closes)' }, [h('i')]);
    var bIco = h('button', { class: 'fv-tb i', type: 'button', 'aria-label': 'Iconify', title: 'Iconify' }, [h('i')]);
    var bMax = h('button', { class: 'fv-tb x', type: 'button', 'aria-label': 'Maximize', title: 'Maximize' }, [h('i')]);
    this.el = h('div', { class: 'fv-win', tabindex: '-1', role: 'dialog', 'aria-label': this.title }, [
      h('div', { class: 'fv-inner' }, [h('div', { class: 'fv-title' }, [bMenu, this.tt, bIco, bMax]), this.client])
    ]);
    ['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se'].forEach(function (dir) {
      var z = h('div', { class: 'fv-rs ' + dir });
      z.addEventListener('pointerdown', function (ev) { self.startResize(ev, dir); });
      self.el.insertBefore(z, self.el.firstChild);
    });
    this.tt.addEventListener('pointerdown', function (ev) { self.startMove(ev); });
    this.tt.addEventListener('dblclick', function () { self.toggleMax(); });
    bMenu.addEventListener('click', function () { var r = bMenu.getBoundingClientRect(); windowMenu(self, r.left, r.bottom); });
    bMenu.addEventListener('dblclick', function () { closeMenus(); self.close(); });
    bIco.addEventListener('click', function () { self.iconify(); });
    bMax.addEventListener('click', function () { self.toggleMax(); });
    this.el.addEventListener('pointerdown', function () { self.raise(); focusWin(self, true); }, true);
    this.el.addEventListener('mouseenter', function () { if (CFG.focus === 'sloppy' && shield.style.display !== 'block' && !openMenus.length) focusWin(self); });
    this.el.addEventListener('keydown', function (ev) { if (ev.key === 'Escape' && o.escCloses) self.close(); });
    /* Files dragged in from the host: a window that names a container (win.dropTarget) accepts them. */
    function over(ev) {
      if (self.dropPaneActive) return;                 // a drop pane is the target; let its own handlers accept the drop
      var files = hasFiles(ev), inner = isInternal(ev); if (!files && !inner) return;
      // An app that accepts object drops (e.g. queues: enqueue) takes a dragged data object window-wide.
      if (inner && !files && self.wantsObjectDrop && self.wantsObjectDrop() && isDraggingObject()) {
        ev.preventDefault(); ev.fvSeen = true; ev.dataTransfer.dropEffect = 'copy';
        self.dropLabel.textContent = self.objectDropHint() + ' ' + (dragging.name || 'object');
        self.el.classList.add('fv-over'); return;
      }
      var to = self.dropTarget ? self.dropTarget() : null, copy = wantsCopy(ev), ok = !!to && (files || canDrop(dragging, to, copy));
      ev.preventDefault(); ev.fvSeen = true; ev.dataTransfer.dropEffect = !ok ? 'none' : files || copy ? 'copy' : 'move';
      if (ok) { var d = diskFor(to); self.dropLabel.textContent = (files ? 'Upload to ' : copy ? 'Copy to ' : 'Move to ') + (d ? d.name + ':' + pathIn(d, to) : to); }
      self.el.classList.toggle('fv-over', ok);
    }
    this.el.addEventListener('dragenter', over); this.el.addEventListener('dragover', over);
    this.el.addEventListener('dragleave', function (ev) { if (!ev.relatedTarget || !self.el.contains(ev.relatedTarget)) self.el.classList.remove('fv-over'); });
    this.el.addEventListener('drop', async function (ev) {
      if (self.dropPaneActive) return;                 // handled by the drop pane
      var files = hasFiles(ev), inner = isInternal(ev); if (!files && !inner) return;
      // An app that accepts object drops handles the dragged data object itself (no container transfer).
      if (inner && !files && self.wantsObjectDrop && self.wantsObjectDrop() && isDraggingObject()) {
        ev.preventDefault(); self.el.classList.remove('fv-over'); self.raise(); focusWin(self, true);
        self.objectDrop({ url: dragging.url, name: dragging.name, kind: dragging.kind, type: dragging.type });
        return;
      }
      ev.preventDefault(); self.el.classList.remove('fv-over');
      var to = self.dropTarget ? self.dropTarget() : null; if (!to) return;
      self.raise(); focusWin(self, true);
      if (inner) {
        var src = dragging, copy = wantsCopy(ev); if (!canDrop(src, to, copy)) return;
        var done = await transfer(src, to, copy, self.dropProgress);
        if (done && self.dropDone && !self.isBrowser) self.dropDone([{ name: src.name, size: 0, outcome: copy ? 'copied' : 'moved' }], to);
        return;
      }
      var col = collectDrop(ev.dataTransfer);
      var results = await uploadFiles(to, await expandDrop(col), self.dropProgress);
      if (self.dropDone) self.dropDone(results, to);
      var bad = results.filter(function (r) { return /^(failed|skipped:)/.test(r.outcome); });
      if (bad.length) messageBox('Upload', bad.map(function (r) { return r.name + ' \u2014 ' + r.outcome; }).join('\n'));
    });

    this.wid = 'win' + (++winUid);
    view.appendChild(this.el); WM.wins.push(this);
    this.apply(); this.raise(); focusWin(this);
  }
  Win.prototype.apply = function () {
    var s = this.el.style;
    s.left = (this.dx * vw() + this.x) + 'px'; s.top = (this.dy * vh() + this.y) + 'px';
    s.width = this.w + 'px'; s.height = this.h + 'px';
  };
  Win.prototype.setTitle = function (t) { this.title = t; this.tt.textContent = t; this.el.setAttribute('aria-label', t); if (this.iconEl) this.iconEl.lastChild.textContent = t; changed(); };
  Win.prototype.setIcon = function (src) { this.iconURL = src; if (this.iconEl) { var b = this.iconEl.firstChild; b.textContent = ''; b.appendChild(iconImg(src, 36)); } };
  var TITLEBAR = 22, CHROME = 14;      // the title row, and the frame + inner-bevel padding around the client
  /* The height the window must have for a client area of width w at the locked aspect ratio (client w/h). */
  Win.prototype.heightForWidth = function (w) { return Math.round((w - CHROME) / this.aspect) + TITLEBAR + CHROME; };
  Win.prototype.setAspect = function (r) {
    this.aspect = r > 0 ? r : 0;
    if (this.aspect) { this.h = clamp(this.heightForWidth(this.w), this.minH, vh()); this.w = clamp(Math.round((this.h - TITLEBAR - CHROME) * this.aspect) + CHROME, this.minW, vw()); this.apply(); changed(); }
  };
  Win.prototype.resizeTo = function (w, hgt) {
    if (this.maxed || !(w > 0) || !(hgt > 0)) return;
    this.w = clamp(Math.round(w), this.minW, vw());
    this.h = this.aspect ? clamp(this.heightForWidth(this.w), this.minH, vh()) : clamp(Math.round(hgt), this.minH, vh());
    this.x = clamp(this.x, 0, Math.max(0, vw() - this.w)); this.y = clamp(this.y, 0, Math.max(0, vh() - this.h));
    this.apply(); changed();
  };
  Win.prototype.raise = function () { this.el.style.zIndex = ++WM.z; changed(); };
  Win.prototype.lower = function () {
    var min = WM.z; WM.wins.forEach(function (w) { min = Math.min(min, +w.el.style.zIndex || 0); });
    this.el.style.zIndex = min - 1; changed();
  };
  Win.prototype.startMove = function (ev) {
    if (this.maxed) return;
    var self = this, ox = this.x, oy = this.y;
    dragSession(ev, 'move', function (dx, dy) { self.x = ox + dx; self.y = clamp(oy + dy, -4, vh() - 30); self.apply(); });
  };
  Win.prototype.startResize = function (ev, dir) {
    if (this.maxed) return;
    var self = this, o = { x: this.x, y: this.y, w: this.w, h: this.h };
    dragSession(ev, dir + '-resize', function (dx, dy) {
      if (dir.indexOf('e') >= 0) self.w = Math.max(self.minW, o.w + dx);
      if (dir.indexOf('s') >= 0) self.h = Math.max(self.minH, o.h + dy);
      if (dir.indexOf('w') >= 0) { self.w = Math.max(self.minW, o.w - dx); self.x = o.x + o.w - self.w; }
      if (dir.indexOf('n') >= 0) { self.h = Math.max(self.minH, o.h - dy); self.y = o.y + o.h - self.h; }
      if (self.aspect) {                                   // hold the ratio: a vertical-only drag drives height, otherwise width drives
        if (dir === 'n' || dir === 's') { self.w = Math.max(self.minW, Math.round((self.h - TITLEBAR - CHROME) * self.aspect) + CHROME); if (dir.indexOf('w') >= 0) self.x = o.x + o.w - self.w; }
        else { self.h = Math.max(self.minH, self.heightForWidth(self.w)); if (dir.indexOf('n') >= 0) self.y = o.y + o.h - self.h; }
      }
      self.apply();
    });
  };
  Win.prototype.toggleMax = function () {
    if (this.maxed) { var m = this.maxed; this.x = m.x; this.y = m.y; this.w = m.w; this.h = m.h; this.maxed = null; }
    else {
      this.maxed = { x: this.x, y: this.y, w: this.w, h: this.h };
      if (this.aspect) { this.w = vw(); this.h = this.heightForWidth(this.w); if (this.h > vh()) { this.h = vh(); this.w = Math.round((this.h - TITLEBAR - CHROME) * this.aspect) + CHROME; } this.x = Math.round((vw() - this.w) / 2); this.y = Math.round((vh() - this.h) / 2); }
      else { this.x = 0; this.y = 0; this.w = vw(); this.h = vh(); }
    }
    this.el.classList.toggle('fv-max', !!this.maxed); this.apply(); this.raise();
  };
  Win.prototype.iconify = function () {
    if (this.iconified) return;
    var self = this; this.iconified = true; this.el.style.display = 'none';
    this.iconEl = h('button', { class: 'fv-icon', type: 'button', title: 'Click to restore' }, [this.iconURL ? h('b', {}, [iconImg(this.iconURL, 36)]) : h('b', { html: icon(this.iconName, 36) }), h('span', { text: this.title })]);
    this.iconEl.addEventListener('click', function () { self.deiconify(); });
    iconsEl.appendChild(this.iconEl);
    if (WM.focused === this) focusWin(null);
    changed();
  };
  Win.prototype.deiconify = function () {
    if (this.iconified) { this.iconified = false; this.el.style.display = ''; this.iconEl.remove(); this.iconEl = null; }
    gotoDesk(this.dx, this.dy); this.raise(); focusWin(this);
  };
  Win.prototype.sendToDesk = function (dx, dy) { this.dx = dx; this.dy = dy; this.apply(); changed(); };
  Win.prototype.close = function (force) {
    if (this.closed) return;
    if (this.dirty && !force) {                      // an application said it holds unsaved work
      var self = this; this.deiconify();
      confirmBox('Unsaved changes', this.title.replace(/\s*\u2022\s*$/, '') + ' has changes that are not saved. Close it anyway?', 'Discard', 'Keep open').then(function (yes) { if (yes) self.close(true); });
      return;
    }
    this.closed = true;
    if (this.onClose) { try { this.onClose(); } catch (e) { console.error(e); } }
    if (this.iconEl) this.iconEl.remove();
    this.el.remove(); WM.wins.splice(WM.wins.indexOf(this), 1);
    if (WM.focused === this) { WM.focused = null; var back = this.before; if (back && WM.wins.indexOf(back) >= 0 && !back.iconified) focusWin(back); }
    changed();
  };

  function focusWin(w, force) {
    if (WM.focused === w && !force) return;
    if (WM.focused) WM.focused.el.classList.remove('fv-focus');
    WM.focused = w;
    if (!w) return;
    w.el.classList.add('fv-focus');
    var frame = w.client.querySelector('iframe');
    if (frame) { try { frame.contentWindow.focus(); } catch (e) { /* not ready */ } }
    else if (!w.el.contains(document.activeElement)) {
      var first = w.client.querySelector('input:not([type=radio]),textarea,[data-autofocus]');
      (first || w.el).focus({ preventScroll: true });
    }
    changed();
  }

  function gotoDesk(x, y) {
    WM.desk = [clamp(x, 0, CFG.desksX - 1), clamp(y, 0, CFG.desksY - 1)];
    view.style.transform = 'translate(' + (-WM.desk[0] * vw()) + 'px,' + (-WM.desk[1] * vh()) + 'px)';
    changed();
  }

  var changeQueued = false;
  function changed() { if (changeQueued || !pagerEl) return; changeQueued = true; requestAnimationFrame(function () { changeQueued = false; drawPager(); }); }

  function drawPager() {
    pagerEl.textContent = '';
    pagerEl.style.gridTemplateColumns = 'repeat(' + CFG.desksX + ',1fr)';
    pagerEl.style.gridTemplateRows = 'repeat(' + CFG.desksY + ',1fr)';
    var cw = (180 - 10) / CFG.desksX, ch = (116 - 10) / CFG.desksY, sx = cw / vw(), sy = ch / vh();
    for (var y = 0; y < CFG.desksY; y++) for (var x = 0; x < CFG.desksX; x++) (function (x, y) {
      var n = y * CFG.desksX + x + 1, cur = WM.desk[0] === x && WM.desk[1] === y;
      var cell = h('button', { class: 'fv-desk' + (cur ? ' cur' : ''), type: 'button', 'aria-label': 'Desk ' + n + (cur ? ' (current)' : ''), title: 'Desk ' + n });
      WM.wins.slice().sort(function (a, b) { return (+a.el.style.zIndex || 0) - (+b.el.style.zIndex || 0); }).forEach(function (w) {
        if (w.iconified || w.dx !== x || w.dy !== y) return;
        cell.appendChild(h('u', { class: w === WM.focused ? 'f' : '', style: 'left:' + w.x * sx + 'px;top:' + w.y * sy + 'px;width:' + w.w * sx + 'px;height:' + w.h * sy + 'px' }));
      });
      cell.addEventListener('click', function () { gotoDesk(x, y); });
      pagerEl.appendChild(cell);
    })(x, y);
  }

  /* ------------------------------------------------------------------ menus */

  var openMenus = [];
  function closeMenus(level) { while (openMenus.length > (level || 0)) openMenus.pop().remove(); }

  function popupMenu(x, y, title, items, level) {
    level = level || 0; closeMenus(level);
    var m = h('div', { class: 'fv-menu', role: 'menu' }, [title ? h('h6', { text: title }) : null]);
    items.forEach(function (it) {
      if (it === '-') { m.appendChild(h('div', { class: 'fv-sep' })); return; }
      var b = h('button', { class: 'fv-mi', type: 'button', role: 'menuitem', disabled: it.disabled ? '' : null }, [h('span', { text: it.label }), h('span', { text: it.submenu ? '\u25B8' : '', 'aria-hidden': 'true' })]);
      function openSub() { var r = b.getBoundingClientRect(); closeMenus(level + 1); m.querySelectorAll('.open').forEach(function (n) { n.classList.remove('open'); }); b.classList.add('open'); popupMenu(r.right - 4, r.top - 3, null, it.submenu(), level + 1); }
      b.addEventListener('mouseenter', function () { if (it.submenu) openSub(); else { closeMenus(level + 1); m.querySelectorAll('.open').forEach(function (n) { n.classList.remove('open'); }); } });
      b.addEventListener('click', function () { if (it.submenu) return openSub(); closeMenus(); if (it.action) it.action(); });
      m.appendChild(b);
      if (it.later) it.later(function (label, enabled) { if (label) b.firstChild.textContent = label; b.disabled = !enabled; });      // an entry that has to ask the server what it is
    });
    root.appendChild(m); openMenus.push(m);
    m.style.left = clamp(x, 0, vw() - m.offsetWidth) + 'px'; m.style.top = clamp(y, 0, vh() - m.offsetHeight) + 'px';
    if (level === 0) { var f = m.querySelector('.fv-mi:not([disabled])'); if (f) f.focus({ preventScroll: true }); }
    return m;
  }

  function deskItems(fn) {
    var out = [];
    for (var y = 0; y < CFG.desksY; y++) for (var x = 0; x < CFG.desksX; x++) (function (x, y) { out.push({ label: 'Desk ' + (y * CFG.desksX + x + 1), action: function () { fn(x, y); } }); })(x, y);
    return out;
  }
  function windowListItems() {
    if (!WM.wins.length) return [{ label: '(no windows)', disabled: true }];
    return WM.wins.map(function (w) { return { label: (w.iconified ? '(' + w.title + ')' : w.title) + '   \u00B7 desk ' + (w.dy * CFG.desksX + w.dx + 1), action: function () { w.deiconify(); } }; });
  }
  function windowMenu(w, x, y) {
    popupMenu(x, y, 'Window Ops', [
      { label: 'Raise', action: function () { w.raise(); } }, { label: 'Lower', action: function () { w.lower(); } },
      { label: 'Iconify', action: function () { w.iconify(); } }, { label: w.maxed ? 'Restore size' : 'Maximize', action: function () { w.toggleMax(); } },
      { label: 'Send to desk', submenu: function () { return deskItems(function (dx, dy) { w.sendToDesk(dx, dy); }); } },
      '-'
    ].concat(w.extraMenu ? w.extraMenu().concat(['-']) : [], [{ label: 'Close', action: function () { w.close(); } }]));
  }
  /* Light/dark is one setting for the whole desktop, shared with the apps through the "cvwm.dark" key in
     localStorage. The desktop applies it to #fv-root; each app follows the same key in its own document. A change
     made here is written to the key and reaches the app windows (separate documents) as a storage event; a change
     made in an app arrives here the same way. A storage event does not fire in the window that made the change, so
     each originator applies its own. */
  var THEME_KEY = 'cvwm.dark';
  function isDark() { try { return localStorage.getItem(THEME_KEY) === 'on'; } catch (e) { return false; } }
  function applyTheme(on) { if (root) root.classList.toggle('fv-dark', !!on); }
  function setDark(on) { try { localStorage.setItem(THEME_KEY, on ? 'on' : 'off'); } catch (e) { /* kept for this page */ } applyTheme(on); }
  window.addEventListener('storage', function (ev) { if (ev.key === THEME_KEY) applyTheme(ev.newValue === 'on'); });

  function rootMenu(x, y) {
    popupMenu(x, y, 'cvwm', [
      { label: 'Rescan namespaces', action: rescan }, { label: 'Connect to base URI\u2026', action: function () { connectDialog(); } },
      '-',
      { label: 'New xterm', disabled: !helpers.xterm, action: function () { launchXterm(null); } }, { label: 'New Textile', disabled: !helpers.textile, action: function () { launchApp(helpers.textile); } }, { label: 'Console', disabled: !helpers.console, action: function () { launchApp(helpers.console); } },
      { label: 'CDMI', submenu: function () { return [
        { label: 'Browse the network\u2026', disabled: !helpers.servers, action: function () { launchApp(helpers.servers); } },
        { label: 'Namespaces\u2026', disabled: !helpers.namespaces, action: function () { launchApp(helpers.namespaces); } },
        { label: 'Domains\u2026', disabled: !helpers.domains, action: function () { launchApp(helpers.domains); } },
        { label: 'Relationships\u2026', disabled: !helpers.relationships, action: function () { launchApp(helpers.relationships); } },
        { label: 'CDMI requests\u2026', disabled: !helpers.postcdmi, action: function () { launchApp(helpers.postcdmi); } },
        { label: 'Queues\u2026', disabled: !helpers.queues, action: function () { launchApp(helpers.queues); } },
        { label: 'Notifications\u2026', disabled: !helpers.notifications, action: function () { launchApp(helpers.notifications); } },
        { label: 'Query\u2026', disabled: !helpers.query, action: function () { launchApp(helpers.query); } },
        { label: 'Server capabilities', action: function () { if (helpers.capabilities) launchApp(helpers.capabilities); else showCapabilities(); } }
      ]; } },
      '-',
      { label: 'Window list', submenu: windowListItems }, { label: 'Go to desk', submenu: function () { return deskItems(gotoDesk); } },
      { label: 'Focus: ' + (CFG.focus === 'sloppy' ? 'follows mouse' : 'click') + ' (toggle)', action: function () { CFG.focus = CFG.focus === 'sloppy' ? 'click' : 'sloppy'; } },
      { label: 'Pager: ' + (CFG.pagerVisible ? 'visible' : 'hidden') + ' (toggle)', action: function () { CFG.pagerVisible = !CFG.pagerVisible; if (pagerEl) pagerEl.style.display = CFG.pagerVisible ? 'grid' : 'none'; } },
      { label: 'Dark mode: ' + (isDark() ? 'on' : 'off') + ' (toggle)', action: function () { setDark(!isDark()); } },
      '-',
      { label: CD.auth ? 'Sign out' : 'Sign in\u2026', action: function () { if (CD.auth) { CD.auth = null; rescan(); } else signInDialog().then(function (ok) { if (ok) rescan(); }); } },
      { label: 'Known hosts', action: knownHostsWindow }, { label: 'About', action: aboutDialog }
    ]);
  }

  /* ------------------------------------------------------------------ dialogs */

  function field(id, label, value, type) {
    var input = h('input', { class: 'fv-in', id: id, type: type || 'text', value: value || '', autocomplete: 'off', spellcheck: 'false' });
    return { row: h('div', { class: 'fv-row' }, [h('label', { for: id, text: label }), input]), input: input };
  }
  var uid = 0;

  function messageBox(title, text) {
    var ok = h('button', { class: 'fv-btn', type: 'button', text: 'OK', 'data-autofocus': '' });
    var w = new Win({ title: title, w: 420, h: 190, center: true, escCloses: true, content: h('div', { class: 'fv-form' }, [h('p', { text: text }), h('div', { class: 'fv-row end' }, [ok])]) });
    ok.addEventListener('click', function () { w.close(); }); ok.focus();
    return w;
  }

  function confirmBox(title, text, yes, no) {
    return new Promise(function (resolve) {
      var answered = false, bNo = h('button', { class: 'fv-btn', type: 'button', text: no || 'Cancel' }), bYes = h('button', { class: 'fv-btn', type: 'button', text: yes || 'OK', 'data-autofocus': '' });
      var w = new Win({ title: title, w: 430, h: 180, center: true, escCloses: true, onClose: function () { if (!answered) resolve(false); },
        content: h('div', { class: 'fv-form' }, [h('p', { text: text }), h('div', { class: 'fv-row end' }, [bNo, bYes])]) });
      bYes.addEventListener('click', function () { answered = true; w.close(); resolve(true); }); bNo.addEventListener('click', function () { w.close(); });
      bYes.focus();
    });
  }

  function chooseBox(title, text, labels) {       // resolves with the index of the button pressed; closing is 0
    return new Promise(function (resolve) {
      var answered = false, buttons = labels.map(function (l, i) { var b = h('button', { class: 'fv-btn', type: 'button', text: l }); b.addEventListener('click', function () { answered = true; w.close(); resolve(i); }); return b; });
      var w = new Win({ title: title, w: 520, h: 190, center: true, escCloses: true, onClose: function () { if (!answered) resolve(0); },
        content: h('div', { class: 'fv-form' }, [h('p', { text: text }), h('div', { class: 'fv-row end' }, buttons)]) });
      buttons[buttons.length - 1].focus();
    });
  }

  function promptBox(title, text, label, value, okLabel) {
    return new Promise(function (resolve) {
      var n = ++uid, f = field('fvq' + n, label, value), answered = false, status = h('p', { text: '' });
      var cancel = h('button', { class: 'fv-btn', type: 'button', text: 'Cancel' }), ok = h('button', { class: 'fv-btn', type: 'button', text: okLabel || 'OK' });
      var w = new Win({ title: title, w: 460, h: 220, center: true, escCloses: true, onClose: function () { if (!answered) resolve(null); },
        content: h('div', { class: 'fv-form' }, [h('p', { text: text }), f.row, status, h('div', { class: 'fv-row end' }, [cancel, ok])]) });
      function submit() { var v = f.input.value.trim(); if (!v) { status.textContent = 'Type a name.'; return; } if (/[\/?]/.test(v)) { status.textContent = 'A name holds no "/" or "?".'; return; } answered = true; w.close(); resolve(v); }
      ok.addEventListener('click', submit); cancel.addEventListener('click', function () { w.close(); });
      w.el.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' && ev.target.tagName === 'INPUT') submit(); });
      f.input.select();
    });
  }

  /* 6. A snapshot is made by an update of the container that carries a "snapshot" field naming it; it then stands,
     read only, at cdmi_snapshots/<name>/ within that container. */
  async function createSnapshot(url, label) {
    var now = new Date(), p = function (n) { return (n < 10 ? '0' : '') + n; };
    var suggested = now.getFullYear() + '-' + p(now.getMonth() + 1) + '-' + p(now.getDate()) + 'T' + p(now.getHours()) + p(now.getMinutes());
    var name = await promptBox('Create snapshot', 'A snapshot keeps ' + label + ' and everything in it as they are now. It appears in cdmi_snapshots/ inside the container.', 'Name', suggested, 'Create');
    if (!name) return;
    try {
      var res = await send('PATCH', url, T_CONTAINER, JSON.stringify({ snapshot: name }));
      if (!res.ok) throw await toError(res);
      openContainer(url + 'cdmi_snapshots/', { browse: true });
    } catch (e) { messageBox('Cannot create the snapshot', e.status === 409 || e.status === 412 ? 'A snapshot named ' + name + ' already exists. ' + e.message : e.message); }
  }

  /* 3. cdmi_objectid/ is not a container to look around in: it addresses objects by ID, so ask for one. */
  function objectIdDialog(d, into) {
    var n = ++uid, id = field('fvo' + n, 'Object ID', ''), status = h('p', { text: '' });
    var cancel = h('button', { class: 'fv-btn', type: 'button', text: 'Cancel' }), ok = h('button', { class: 'fv-btn', type: 'button', text: 'Open' });
    var fresh = h('button', { class: 'fv-btn', type: 'button', text: 'New container', title: 'Create a container that has no name and no parent, reached by its object ID alone' });
    var w = new Win({ title: 'Open by object ID \u00B7 ' + d.name, w: 560, h: 250, center: true, escCloses: true,
      content: h('div', { class: 'fv-form' }, [h('p', { text: 'Objects are addressed at ' + pathIn(d, d.base + 'cdmi_objectid/') + '<object ID>. Get info on any object shows its ID.' }), id.row, status, h('div', { class: 'fv-row end' }, [fresh, h('span', { style: 'flex:1' }), cancel, ok])]) });
    /* A create with a server-assigned name, addressed to cdmi_objectid/ itself, makes an object that is a child of
       nothing. The draft's capabilities speak of data objects and queue objects made this way; a server that
       makes no containers so says as much, and its answer is shown. */
    // A container created by object ID has no name and no parent. seedmi refuses the create unless the POST already
    // carries an HTTP export (the container must be reachable at an origin from the moment it exists), so the export
    // is collected first and sent as part of the create -- not added afterwards with PATCH.
    fresh.addEventListener('click', function () { w.close(); newContainerByObjectId(d, into); });
    async function submit() {
      var v = id.input.value.trim();
      if (!v) { status.textContent = 'Type an object ID.'; return; }
      if (/[\/?]/.test(v) || new TextEncoder().encode(v).length > 255) { status.textContent = 'An object ID is at most 255 octets and holds no "/" or "?".'; return; }
      status.textContent = 'Looking up ' + v + ' \u2026';
      try { await openObject(d.base + 'cdmi_objectid/' + enc(v), v, into, true); w.close(); }     // a container answers 307 to the form ending in "/"
      catch (e) { status.textContent = e.status === 404 ? 'No object has that ID in ' + d.name + '.' : e.message; }
    }
    ok.addEventListener('click', submit); cancel.addEventListener('click', function () { w.close(); });
    w.el.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' && ev.target.tagName === 'INPUT') submit(); });
    return w;
  }

  /* Create a container by object ID. seedmi denies the create at cdmi_objectid/ unless the POST already names an
     HTTP export, because a container that has no name and no parent must be reachable at an origin from the moment
     it exists. So the export is collected first and sent in the POST body; there is no create-then-PATCH. The export
     names this origin, since cvwm mounts only a same-origin base URI. */
  /* ---------------------------------------------------------- ACL builder */
  /* An access control list editor, per CDMI 3.0 (revision 354) Clause "Access control". It edits a cdmi_acl array,
     each entry an access control entry: acetype (ALLOW/DENY), identifier (a principal or a special like OWNER@),
     aceflags (inheritance), and acemask (the permission bits). aclBuilder(initial, opts) returns
     { el, value() } -- el is the editor element to place in a form, value() returns the current cdmi_acl array
     (or null if empty). The mask bit names and values are those of Table "ACE mask bit values". */
  var ACE_BITS = [
    { n: 'READ_OBJECT',        v: 0x00000001, file: true,  desc: 'Read the value of a data object' },
    { n: 'LIST_CONTAINER',     v: 0x00000001, dir: true,   desc: 'List the children of a container' },
    { n: 'WRITE_OBJECT',       v: 0x00000002, file: true,  desc: 'Modify the value of a data object' },
    { n: 'ADD_OBJECT',         v: 0x00000002, dir: true,   desc: 'Add a data object to a container' },
    { n: 'APPEND_DATA',        v: 0x00000004, file: true,  desc: 'Append to a data object or queue' },
    { n: 'ADD_SUBCONTAINER',   v: 0x00000004, dir: true,   desc: 'Add a child container' },
    { n: 'READ_METADATA',      v: 0x00000008, both: true,  desc: 'Read metadata' },
    { n: 'WRITE_METADATA',     v: 0x00000010, both: true,  desc: 'Write metadata' },
    { n: 'EXECUTE',            v: 0x00000020, file: true,  desc: 'Execute a data object' },
    { n: 'TRAVERSE',           v: 0x00000020, dir: true,   desc: 'Traverse a container' },
    { n: 'DELETE_OBJECT',      v: 0x00000040, dir: true,   desc: 'Delete a child data object' },
    { n: 'DELETE_SUBCONTAINER',v: 0x00000040, dir: true,   desc: 'Delete a child container' },
    { n: 'READ_ATTRIBUTES',    v: 0x00000080, both: true,  desc: 'Read attributes' },
    { n: 'WRITE_ATTRIBUTES',   v: 0x00000100, both: true,  desc: 'Write attributes' },
    { n: 'DELETE',             v: 0x00010000, both: true,  desc: 'Delete this object' },
    { n: 'READ_ACL',           v: 0x00020000, both: true,  desc: 'Read the ACL and owner' },
    { n: 'WRITE_ACL',          v: 0x00040000, both: true,  desc: 'Write the ACL' },
    { n: 'WRITE_OWNER',        v: 0x00080000, both: true,  desc: 'Change the owner' },
    { n: 'SYNCHRONIZE',        v: 0x00100000, both: true,  desc: 'Synchronize access' }
  ];
  var ACE_ALL = 0x001F07FF;          // ALL_PERMS
  var ACE_READ = 0x00020089;         // READ_ALL: READ_OBJECT/LIST + READ_METADATA + READ_ATTRIBUTES + READ_ACL
  var ACE_WRITE = 0x0006006F;        // WRITE_ALL
  var ACE_FLAGS = [
    { n: 'OBJECT_INHERIT',       v: 'OBJECT_INHERIT',       desc: 'child data objects inherit this entry' },
    { n: 'CONTAINER_INHERIT',    v: 'CONTAINER_INHERIT',    desc: 'child containers inherit this entry' },
    { n: 'NO_PROPAGATE_INHERIT', v: 'NO_PROPAGATE_INHERIT', desc: 'inherit one level only' },
    { n: 'INHERIT_ONLY',         v: 'INHERIT_ONLY',         desc: 'applies to children, not this object' }
  ];
  var ACE_IDENTIFIERS = ['OWNER@', 'GROUP@', 'EVERYONE@', 'AUTHENTICATED@', 'ANONYMOUS@', 'ADMINISTRATOR@', 'ADMINUSERS@'];
  var ACE_PRESETS = [
    { label: 'Full control', mask: ACE_ALL },
    { label: 'Read',         mask: ACE_READ },
    { label: 'Read & write', mask: ACE_READ | ACE_WRITE },
    { label: 'Custom',       mask: -1 }
  ];

  /* Evaluate a cdmi_acl against a principal, NFSv4-style: walk the entries in order; the first entry that
     mentions a still-unmet requested bit decides it (ALLOW grants, DENY refuses), and any requested bit that
     no ALLOW covers is denied. Returns true (granted), false (refused) or null (no ACL to decide from). The
     mask bit names/values are the ACE_BITS above; ADD_SUBCONTAINER (0x4) is the bit that permits creating a
     child container -- and, for a domain object, a sub-domain. */
  var ACE_ADD_SUBCONTAINER = 0x00000004;
  function aceMaskVal(m) {
    if (typeof m === 'number') return m >>> 0;
    if (m == null) return 0;
    var s = String(m).trim();
    if (/^0x[0-9a-f]+$/i.test(s)) return parseInt(s, 16) >>> 0;
    if (/^[0-9]+$/.test(s)) return parseInt(s, 10) >>> 0;
    var acc = 0;
    s.split(/[,\s|]+/).forEach(function (tok) {
      tok = tok.trim().toUpperCase(); if (!tok) return;
      if (tok === 'ALL_PERMS') { acc |= ACE_ALL; return; }
      if (tok === 'READ_ALL') { acc |= ACE_READ; return; }
      if (tok === 'WRITE_ALL') { acc |= ACE_WRITE; return; }
      if (tok === 'RWX') { acc |= ACE_READ | ACE_WRITE | 0x20; return; }
      ACE_BITS.forEach(function (b) { if (b.n === tok) acc |= b.v; });
    });
    return acc >>> 0;
  }
  function aceIsDeny(t) { var s = String(t == null ? 'ALLOW' : t).trim(); return /deny/i.test(s) || s === '0x01' || s === '0x1' || s === '1'; }
  function aceApplies(id, P) {
    var raw = String(id == null ? '' : id).trim(), U = raw.toUpperCase();
    if (U === 'EVERYONE@') return true;
    if (U === 'ANONYMOUS@') return !P.authenticated;
    if (U === 'AUTHENTICATED@') return !!P.authenticated;
    if (U === 'OWNER@') return !!(P.identifier && P.owner && P.identifier === P.owner);
    if (U === 'GROUP@') return !!(P.owningGroup && P.groups.indexOf(P.owningGroup) >= 0);
    if (U === 'ADMINISTRATOR@' || U === 'ADMINUSERS@') return !!P.admin;
    return (!!P.identifier && raw === P.identifier) || (P.groups.indexOf(raw) >= 0);
  }
  function aclDecision(acl, requested, P) {
    if (!Array.isArray(acl) || !acl.length) return null;
    var remaining = requested >>> 0;
    for (var i = 0; i < acl.length; i++) {
      var ace = acl[i] || {};
      if (!aceApplies(ace.identifier, P)) continue;
      var m = aceMaskVal(ace.acemask) & remaining;
      if (!m) continue;
      if (aceIsDeny(ace.acetype)) return false;    // an unmet requested bit is explicitly denied
      remaining &= ~m;
      if (!remaining) return true;
    }
    return remaining === 0;                          // NFSv4: a bit no ALLOW covered is denied
  }
  // Build the current principal, taking the owner/owning-group context from an object's representation.
  function principalFor(rep) {
    var u = CD.userinfo || {};
    var groups = Array.isArray(u.groups) ? u.groups.slice() : (typeof u.groups === 'string' ? u.groups.split(/[,\s]+/).filter(Boolean) : []);
    var priv = u.privileges; priv = Array.isArray(priv) ? priv.join(',') : String(priv || '');
    var md = (rep && rep.metadata) || {};
    return { identifier: u.identifier || null, groups: groups, authenticated: !!CD.auth,
      admin: /\b(admin|cross_domain|administrator)\b/i.test(priv), owner: md.cdmi_owner || null, owningGroup: md.cdmi_group || null };
  }

  function maskToNames(mask, forDir) {
    if ((mask & ACE_ALL) === ACE_ALL) return 'ALL_PERMS';
    var out = [], seen = 0;
    ACE_BITS.forEach(function (b) {
      if (!(mask & b.v)) return;
      if (b.both || (forDir ? b.dir : b.file)) { if (!(seen & b.v)) { out.push(b.n); seen |= b.v; } }
    });
    // any bits not covered by the dir/file view (rare) -- include their canonical name once
    ACE_BITS.forEach(function (b) { if ((mask & b.v) && !(seen & b.v)) { out.push(b.n); seen |= b.v; } });
    return out.join(', ');
  }

  function aclBuilder(initial, opts) {
    opts = opts || {};
    var forDir = opts.forDir !== false;                 // default: editing a container's ACL
    var n0 = ++uid;
    var list = h('div', { class: 'fv-acl-list' });
    var rows = [];

    function parseMask(m) {
      if (typeof m === 'number') return m >>> 0;
      if (m == null) return 0;
      var s = String(m).trim();
      if (/^0x[0-9a-f]+$/i.test(s)) return parseInt(s, 16) >>> 0;
      if (/^[0-9]+$/.test(s)) return parseInt(s, 10) >>> 0;
      var acc = 0;
      s.split(/[,\s|]+/).forEach(function (tok) {
        tok = tok.trim().toUpperCase(); if (!tok) return;
        if (tok === 'ALL_PERMS') { acc |= ACE_ALL; return; }
        if (tok === 'READ_ALL') { acc |= ACE_READ; return; }
        if (tok === 'WRITE_ALL') { acc |= ACE_WRITE; return; }
        if (tok === 'RWX') { acc |= ACE_READ | ACE_WRITE | 0x20; return; }
        ACE_BITS.forEach(function (b) { if (b.n === tok) acc |= b.v; });
      });
      return acc >>> 0;
    }

    function addRow(ace) {
      ace = ace || {};
      var n = ++uid;
      var mask = parseMask(ace.acemask != null ? ace.acemask : ACE_READ);
      var type = /deny/i.test(ace.acetype || 'ALLOW') ? 'DENY' : 'ALLOW';
      var flagsStr = String(ace.aceflags || 'NO_FLAGS').toUpperCase();

      var typeSel = h('select', { class: 'fv-in fv-acl-type' }, ['ALLOW', 'DENY'].map(function (t) {
        return h('option', { value: t, text: t, selected: t === type ? 'selected' : null });
      }));
      var idIn = h('input', { class: 'fv-in', list: 'fv-acl-ids-' + n0, value: ace.identifier || 'EVERYONE@', spellcheck: 'false', autocomplete: 'off', placeholder: 'principal or OWNER@' });

      var presetSel = h('select', { class: 'fv-in fv-acl-preset' }, ACE_PRESETS.map(function (p) {
        return h('option', { value: String(p.mask), text: p.label });
      }));
      // choose the preset that matches, else Custom
      (function () {
        var matched = ACE_PRESETS.filter(function (p) { return p.mask >= 0 && (mask >>> 0) === (p.mask >>> 0); })[0];
        presetSel.value = String(matched ? matched.mask : -1);
      })();

      var bitsWrap = h('div', { class: 'fv-acl-bits' });
      var bitBoxes = [];
      ACE_BITS.forEach(function (b) {
        if (!(b.both || (forDir ? b.dir : b.file))) return;   // show only the bits meaningful for this kind
        var cb = h('input', { type: 'checkbox', id: 'b' + n + '_' + b.v.toString(16) });
        cb.checked = !!(mask & b.v); cb._bit = b.v;
        bitBoxes.push(cb);
        bitsWrap.appendChild(h('label', { class: 'fv-acl-bit', title: b.desc, for: cb.id }, [cb, h('span', { text: b.n })]));
      });
      function curMask() { var m = 0; bitBoxes.forEach(function (cb) { if (cb.checked) m |= cb._bit; }); return m >>> 0; }
      function setBits(m) { bitBoxes.forEach(function (cb) { cb.checked = !!(m & cb._bit); }); }
      function syncPresetFromBits() {
        var m = curMask();
        var matched = ACE_PRESETS.filter(function (p) { return p.mask >= 0 && m === (p.mask >>> 0); })[0];
        presetSel.value = String(matched ? matched.mask : -1);
      }
      presetSel.addEventListener('change', function () {
        var v = parseInt(presetSel.value, 10);
        if (v >= 0) { setBits(v); bitsWrap.style.display = 'none'; }
        else { bitsWrap.style.display = ''; }
      });
      bitBoxes.forEach(function (cb) { cb.addEventListener('change', syncPresetFromBits); });
      bitsWrap.style.display = presetSel.value === '-1' ? '' : 'none';

      var flagBoxes = [];
      var flagsWrap = h('div', { class: 'fv-acl-flags' });
      if (forDir) ACE_FLAGS.forEach(function (f) {
        var cb = h('input', { type: 'checkbox', id: 'f' + n + '_' + f.v });
        cb.checked = flagsStr.indexOf(f.v) >= 0; cb._flag = f.v;
        flagBoxes.push(cb);
        flagsWrap.appendChild(h('label', { class: 'fv-acl-bit', title: f.desc, for: cb.id }, [cb, h('span', { text: f.n })]));
      });

      var rm = h('button', { class: 'fv-btn fv-acl-rm', type: 'button', title: 'Remove this entry', text: '\u00d7' });
      var row = h('div', { class: 'fv-acl-ace' }, [
        h('div', { class: 'fv-acl-head' }, [typeSel, idIn, presetSel, rm]),
        bitsWrap,
        forDir ? h('div', { class: 'fv-acl-flagrow' }, [h('span', { class: 'fv-acl-flabel', text: 'Inheritance' }), flagsWrap]) : null
      ]);
      var rec = {
        el: row,
        value: function () {
          var m = presetSel.value === '-1' ? curMask() : (parseInt(presetSel.value, 10) >>> 0);
          var flags = flagBoxes.filter(function (c) { return c.checked; }).map(function (c) { return c._flag; });
          return {
            acetype: typeSel.value,
            identifier: idIn.value.trim() || 'EVERYONE@',
            aceflags: flags.length ? flags.join(', ') : 'NO_FLAGS',
            acemask: maskToNames(m, forDir) || 'READ_METADATA'
          };
        }
      };
      rm.addEventListener('click', function () { var i = rows.indexOf(rec); if (i >= 0) rows.splice(i, 1); row.remove(); });
      rows.push(rec); list.appendChild(row);
      return rec;
    }

    var datalist = h('datalist', { id: 'fv-acl-ids-' + n0 }, ACE_IDENTIFIERS.map(function (id) { return h('option', { value: id }); }));
    var add = h('button', { class: 'fv-btn', type: 'button', text: '+ Add entry' });
    add.addEventListener('click', function () { addRow({ acetype: 'ALLOW', identifier: 'EVERYONE@', acemask: ACE_READ, aceflags: forDir ? 'OBJECT_INHERIT, CONTAINER_INHERIT' : 'NO_FLAGS' }); });

    (initial && initial.length ? initial : [{ acetype: 'ALLOW', identifier: 'OWNER@', acemask: ACE_ALL, aceflags: forDir ? 'OBJECT_INHERIT, CONTAINER_INHERIT' : 'NO_FLAGS' }]).forEach(addRow);

    var el = h('div', { class: 'fv-acl' }, [datalist, list, h('div', { class: 'fv-row' }, [add])]);
    return {
      el: el,
      value: function () { return rows.length ? rows.map(function (r) { return r.value(); }) : null; }
    };
  }

  function newContainerByObjectId(d, into) {
    var origin = CD.origin, n = ++uid;

    // Spec 354: a container created by object ID is reachable in either of two ways. If the server publishes
    // cdmi_object_access_by_ID, it is the root of its own object ID URI and needs no export. Otherwise the create must
    // supply a CDMI export that publishes it at an origin. We offer both and let the user choose; owner and ACL may be
    // set on the create in both cases.
    var byId = !!(CD.caps && (CD.caps.cdmi_object_access_by_ID === 'true' || CD.caps.cdmi_object_access_by_ID === true));

    // A CDMI export is the primary way to publish the container; an HTTP export may be added beside it. When either is
    // checked the export origin and path apply; when neither is, the container is reached by its object ID only, which
    // requires cdmi_object_access_by_ID, and where the server does not publish that at least one export is required.
    var cdmiExport = h('input', { type: 'checkbox', id: 'pubc' + n }); cdmiExport.checked = true;
    var pubExport = h('input', { type: 'checkbox', id: 'pube' + n }); pubExport.checked = false;
    var path = field('fvxp' + n, 'Export path', '/new-container/');
    var anon = h('input', { type: 'checkbox', id: 'fvxa' + n }); anon.checked = true;

    // The origin the export is served at: a pick-list of the origins this server offers, from the root capability object
    // (cdmi_export_http_origins and cdmi_export_cdmi_origins, per seedmi 0.101), or a free-text field where none are
    // published. Both export types share the one origin here, so the union of what each type allows is offered.
    var caps0 = CD.caps || {}, oCaps = [];
    [caps0.cdmi_export_http_origins, caps0.cdmi_export_cdmi_origins].forEach(function (a) { if (Array.isArray(a)) a.forEach(function (o) { if (oCaps.indexOf(o) < 0) oCaps.push(o); }); });
    var concrete = oCaps.filter(function (o) { return typeof o === 'string' && o.indexOf('*') < 0; });
    if (concrete.length && concrete.indexOf(origin) < 0) concrete = [origin].concat(concrete);
    var originInput = concrete.length
      ? h('select', { class: 'fv-in', id: 'fvxo' + n }, concrete.map(function (o) { return h('option', { value: o, text: o }); }))
      : h('input', { class: 'fv-in', id: 'fvxo' + n, type: 'text', autocomplete: 'off', spellcheck: 'false' });
    originInput.value = origin;
    function originValue() { return (originInput.value || '').trim().replace(/\/$/, ''); }
    var originLabel = h('label', { for: 'fvxo' + n, text: 'Export origin' });
    var originRow = h('div', { class: 'fv-row' }, [originLabel, originInput]);
    var pathLabel = path.row.firstChild;      // the "Export path" label, grayed with the field when no export is chosen

    var domain = field('fvdo' + n, 'Domain', '');
    domain.input.placeholder = 'domainURI (blank = the parent\u2019s domain)';
    var owner = field('fvow' + n, 'Owner', '');
    owner.input.placeholder = 'principal (blank = you); required for another domain';

    var acl = aclBuilder(null, { forDir: true });

    var status = h('p', {});
    var cancel = h('button', { class: 'fv-btn', type: 'button', text: 'Cancel' });
    var ok = h('button', { class: 'fv-btn', type: 'button', text: 'Create' });

    var exportBox = h('div', { class: 'fv-acl-ace' }, [
      h('div', { style: 'display:flex;align-items:center;gap:22px;flex-wrap:wrap' }, [
        h('label', { style: 'display:flex;align-items:center;gap:6px', for: 'pubc' + n }, [cdmiExport, h('b', { text: 'Publish through a CDMI export' })]),
        h('label', { style: 'display:flex;align-items:center;gap:6px', for: 'pube' + n }, [pubExport, h('b', { text: 'Also an HTTP export' })])]),
      h('span', { class: 'fv-acl-flabel', style: 'display:block;width:auto', text: byId ? 'Both are served at the export origin and path below. Otherwise the container is reached by object ID.' : 'Both are served at the export origin and path below. This server has no access by object ID, so at least one export is required.' }),
      originRow,
      path.row,
      h('label', { class: 'fv-row', style: 'gap:6px', for: 'fvxa' + n }, [anon, h('span', { text: 'Allow anonymous read (HTTP export)' })])
    ]);

    var w = new Win({ title: 'New container by object ID \u00B7 ' + d.name, w: 640, h: 560, center: true, escCloses: true,
      content: h('div', { class: 'fv-form' }, [
        h('p', { text: 'A container created by object ID has no name and no parent. Choose how it is reached, and optionally set its owner and access control list.' }),
        exportBox,
        domain.row,
        owner.row,
        h('h6', { text: 'Access control list' }),
        acl.el,
        status,
        h('div', { class: 'fv-row end' }, [cancel, h('span', { style: 'flex:1' }), ok]) ]) });

    function refresh() {
      var useExport = pubExport.checked || cdmiExport.checked;
      path.input.disabled = !useExport; originInput.disabled = !useExport; anon.disabled = !pubExport.checked;
      // Gray the origin and path labels along with their fields when no export is chosen.
      originLabel.style.opacity = pathLabel.style.opacity = useExport ? '' : '.5';
    }
    pubExport.addEventListener('change', refresh); cdmiExport.addEventListener('change', refresh); refresh();
    cancel.addEventListener('click', function () { w.close(); });

    ok.addEventListener('click', async function () {
      var useHttp = pubExport.checked, useCdmi = cdmiExport.checked, useExport = useHttp || useCdmi;
      if (!byId && !useExport) { status.textContent = 'Select at least one export: this server has no access by object ID, so the container would be unreachable.'; return; }
      var body = { metadata: {} };
      var aclv = acl.value(); if (aclv) body.metadata.cdmi_acl = aclv;
      var ownv = owner.input.value.trim(); if (ownv) body.metadata.cdmi_owner = ownv;
      var domv = domain.input.value.trim(); if (domv) body.domainURI = domv;

      var pth = '', originVal = originValue();
      if (useExport) {
        if (!originVal) { status.textContent = 'An export needs an origin.'; return; }
        pth = path.input.value.trim(); if (!/^\//.test(pth)) pth = '/' + pth; if (!/\/$/.test(pth)) pth += '/';
        // An HTTP and a CDMI export at the same origin and path are complementary: the CDMI export serves requests that
        // name a CDMI media type, the HTTP export serves the rest (the spec's migration arrangement).
        body.exports = {};
        if (useHttp) body.exports.web = { type: 'HTTP', origins: [originVal], path: pth, read_only: 'true', anonymous_read: anon.checked ? 'true' : 'false' };
        if (useCdmi) body.exports.cdmi = { type: 'CDMI', origins: [originVal], path: pth };
      }
      status.textContent = 'Creating the container \u2026';
      try {
        var res = await send('POST', d.base + 'cdmi_objectid/', T_CONTAINER, JSON.stringify(body));
        if (!res.ok) throw await toError(res);
        var made = null; try { made = await res.json(); } catch (e) { /* no body */ }
        var oid = (made && made.objectID) || safeDecode(stripQuery(res.headers.get('Location') || '').replace(/\/$/, '').split('/').pop() || '');
        w.close();
        if (useExport) {
          status.textContent = 'Created ' + (oid || '') + ', exported at ' + originVal + pth;
          API.mount(originVal + pth, path.input.value.replace(/^\/|\/$/g, '') || 'export');
          openContainer(originVal + pth, { into: into, browse: true });
        } else {
          // Reached by object ID: open it at its object ID URI on the same disk.
          openContainer(d.base + 'cdmi_objectid/' + enc(oid) + '/', { into: into, browse: true });
        }
      } catch (e) { status.textContent = 'Not created: ' + (e && e.message || e); }
    });
    w.el.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' && ev.target.tagName === 'INPUT') ok.click(); });
  }

  function aboutDialog() {
    messageBox('About cvwm ' + API.version, 'cvwm ' + API.version + ', the CDMI Virtual Window Manager. Disks are the base URIs listed by ' + WELL_KNOWN + 'cdmi_namespaces/ at ' + CD.origin +
      '. A container holding ' + CFG.appEntry + ' runs as an application.');
  }

  async function showCapabilities() {
    await readCapabilities();
    textWindow('Capabilities \u00B7 ' + CD.origin, CD.caps ? JSON.stringify(CD.caps, null, 2) : 'No capability object is readable at ' + WELL_KNOWN + 'cdmi_capabilities/');
  }

  /* A common object dialog (FVWM styled). One click selects a row; two clicks (or Enter) open it -- a container is
     browsed into, a data object is chosen. The Open button instead RETURNS the selected item, so a container can be
     chosen as the result; going up a level is the ".." row (there is no Up button). opts.filter(name, kind) chooses which data objects are
     offered; opts.title and opts.startURI set the window title and where browsing begins; opts.theme === 'dark' gives
     a dark dialog. A version-enabled object carries a small "v" badge, and Versions… (enabled when such an object is
     selected) lists its earlier versions; opening one resolves with that version's by-object-ID URL. In the default
     "open" mode it resolves with the chosen object (or version) URL. With opts.mode === 'save' it is a save/create
     dialog: a name field is shown, selecting an object fills it, and the Save button (opts.saveLabel) resolves with
     the current container's URL plus the entered name; a name that already exists turns Save into Replace (opts.
     replaceLabel) and must be pressed again. Resolves with null on cancel. Apps reach it through
     CTX.desktop.pickObject; cvwm uses it for its own opens too. */
  function pickObject(opts) {
    opts = opts || {};
    var save = opts.mode === 'save';
    var dark = opts.theme ? opts.theme === 'dark' : isDark();   // the calling app chooses the theme; otherwise the desktop's own setting
    return new Promise(function (resolve) {
      var done = false, at = null;                              // at: { base, name, segs } or null (disk list)
      var existing = {}, confirmName = null;                    // object names in the current container, and the one Save has warned it will replace
      var where = h('div', { class: 'where', text: 'Disks' });
      var rows = h('div', { class: 'rows' });
      var hint = save ? h('div', { class: 'hint' }) : null;     // overwrite/validation messages below the list (save mode)
      var cancel = h('button', { class: 'fv-btn', type: 'button', text: 'Cancel' });
      var nameIn = save ? h('input', { class: 'fv-in', type: 'text', spellcheck: 'false', autocomplete: 'off', placeholder: opts.namePlaceholder || 'name', style: 'flex:1;min-width:0' }) : null;
      if (nameIn && opts.name) nameIn.value = opts.name;
      var okBtn = save ? h('button', { class: 'fv-btn', type: 'button', text: opts.saveLabel || 'Save' }) : null;
      // Open mode: one click selects a row, two clicks open it. The Open button RETURNS the selection -- so a container
      // can be chosen as the result, where a double-click on it would instead browse into it. Going up a level is the
      // ".." row (there is no Up button). Versions… browses the earlier versions of a version-enabled object.
      var openBtn = save ? null : h('button', { class: 'fv-btn', type: 'button', text: opts.openLabel || 'Open' });
      var versionsBtn = save ? null : h('button', { class: 'fv-btn', type: 'button', text: 'Versions…', title: 'Browse earlier versions of the selected object' });
      var selEl = null, sel = null, vmode = false;            // the selected row/target, and whether the list is showing versions
      var footer = save ? h('div', { class: 'fv-row', style: 'gap:8px' }, [nameIn, cancel, okBtn])
        : h('div', { class: 'fv-row', style: 'gap:8px' }, [versionsBtn, h('span', { style: 'flex:1' }), cancel, openBtn]);
      var w = new Win({ title: opts.title || (save ? 'Save' : 'Open'), w: 460, h: 420, center: true, escCloses: true,
        onClose: function () { if (!done) { done = true; resolve(null); } },
        content: h('div', { class: 'fv-pick' }, save ? [where, rows, hint, footer] : [where, rows, footer]) });
      if (dark) w.el.classList.add('fv-dark');                 // a dark-themed caller gets a dark dialog
      if (openBtn) { openBtn.disabled = true; openBtn.addEventListener('click', function () { if (sel) (sel.pick || sel.open)(); }); }
      if (versionsBtn) { versionsBtn.disabled = true; versionsBtn.addEventListener('click', function () { if (sel && sel.type === 'file' && sel.versioned) browseVersions(sel); }); }
      function selectRow(b, target) {
        if (selEl) selEl.classList.remove('sel');
        selEl = b; sel = target; if (b) b.classList.add('sel');
        if (save && target && target.type === 'file') { nameIn.value = target.name; resetConfirm(); }
        if (openBtn) openBtn.disabled = !sel;
        if (versionsBtn) versionsBtn.disabled = !(sel && sel.type === 'file' && sel.versioned);
      }
      function clearSel() { if (selEl) selEl.classList.remove('sel'); selEl = null; sel = null; if (openBtn) openBtn.disabled = true; if (versionsBtn) versionsBtn.disabled = true; }
      function finish(url) { if (done) return; done = true; w.close(); resolve(url); }
      function resetConfirm() { confirmName = null; if (okBtn) okBtn.textContent = opts.saveLabel || 'Save'; if (hint) hint.textContent = ''; }
      function doSave() {
        if (!at) { if (hint) hint.textContent = 'Choose a container first.'; return; }   // still at the disk list
        var name = (nameIn.value || '').trim();
        if (!name) { nameIn.focus(); return; }
        if (/[\/?]/.test(name)) { if (hint) hint.textContent = 'A name cannot contain "/" or "?".'; nameIn.focus(); return; }
        if (existing[name] && confirmName !== name) {           // warn once before overwriting an existing object
          confirmName = name; okBtn.textContent = opts.replaceLabel || 'Replace';
          if (hint) hint.textContent = name + ' already exists here — ' + (opts.replaceLabel || 'Replace') + ' to overwrite it.';
          return;
        }
        finish(dirURL(at) + enc(name));
      }
      if (save) { okBtn.addEventListener('click', doSave); nameIn.addEventListener('input', resetConfirm); nameIn.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') doSave(); }); }
      function dirURL(loc) { return loc.base + loc.segs.map(function (x) { return enc(x) + '/'; }).join(''); }
      function locOfURL(url) { var best = null; disks.forEach(function (d) { if (url && url.indexOf(d.base) === 0 && (!best || d.base.length > best.base.length)) best = d; }); return best ? { base: best.base, name: best.name, segs: url.slice(best.base.length).replace(/[?#].*$/, '').split('/').filter(Boolean).map(safeDecode) } : null; }
      // One row: one click selects it, two clicks (or Enter) open it. `target` carries its kind and an open() action;
      // a version-enabled object carries a small badge.
      function makeRow(iconName, label, dim, target) {
        var kids = [h('i', { html: icon(iconName, 16) }), h('span', { class: 'nm', text: label })];
        if (target && target.versioned) kids.push(h('span', { class: 'ver', text: 'v', title: 'Has earlier versions \u2014 Versions\u2026 to browse them' }));
        var b = h('button', { type: 'button', class: dim ? 'dim' : null }, kids);
        b.addEventListener('click', function () { selectRow(b, target); });
        b.addEventListener('dblclick', function () { if (target && target.open) target.open(); });
        b.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); if (target && target.open) target.open(); } });
        rows.appendChild(b); return b;
      }
      async function browse(loc) {
        vmode = false; at = loc; rows.textContent = ''; existing = {}; resetConfirm(); clearSel();
        if (!loc) {
          where.textContent = 'Disks';
          disks.slice().sort(function (a, b) { return (b.home ? 1 : 0) - (a.home ? 1 : 0); }).forEach(function (d) {
            makeRow('disk', (d.home ? 'Home' : d.name) + '  (' + d.base.replace(/^https?:\/\//, '') + ')', d.locked, { type: 'disk', open: function () { browse({ base: d.base, name: d.name, segs: [] }); }, pick: function () { finish(d.base); } });
          });
          if (!rows.firstChild) rows.appendChild(h('p', { text: 'No disks are mounted.' }));
          return;
        }
        where.textContent = loc.name + ':/' + loc.segs.map(function (x) { return x + '/'; }).join('');
        rows.appendChild(h('p', { text: 'Reading \u2026' }));
        var listed;
        try { listed = await listContainer(dirURL(loc), loc.base, true); }   // detailed: one extended listing carries each child's version metadata
        catch (e) { rows.textContent = ''; rows.appendChild(h('p', { text: 'Could not read this container: ' + (e && e.message || e) })); return; }
        if (at !== loc) return;
        rows.textContent = '';
        makeRow('container', '..', false, { type: 'up', open: function () { browse(loc.segs.length ? { base: loc.base, name: loc.name, segs: loc.segs.slice(0, -1) } : null); } });
        var kids = listed.children || [];
        kids.filter(function (c) { return c.kind === 'container' && !/^cdmi_/.test(c.name); }).forEach(function (c) {
          var bare = c.name.replace(/\/$/, '');
          makeRow('container', c.name, false, { type: 'dir',
            open: function () { browse({ base: loc.base, name: loc.name, segs: loc.segs.concat(bare) }); },   // double-click browses in
            pick: function () { finish(dirURL(loc) + enc(bare) + '/'); } });                                 // Open returns the container
        });
        var files = kids.filter(function (c) { return c.kind === 'object'; });
        files.forEach(function (c) { existing[c.name] = 1; });   // names Save warns about before overwriting
        var pass = opts.filter ? files.filter(function (c) { return opts.filter(c.name, c.kind); }) : files;
        var offer = opts.filter ? pass.concat(files.filter(function (c) { return !opts.filter(c.name, c.kind); })) : files;
        offer.forEach(function (c) {
          var dim = opts.filter ? !opts.filter(c.name, c.kind) : false, url = dirURL(loc) + enc(c.name.replace(/[\/?]$/, ''));
          makeRow('object', c.name, dim, { type: 'file', name: c.name, url: url, versioned: !!c.versioned,
            open: function () { if (save) { nameIn.value = c.name; nameIn.focus(); } else finish(url); } });
        });
        if (rows.childNodes.length <= 1) rows.appendChild(h('p', { class: 'empty', text: 'Nothing else here.' }));
      }
      // Read a version-enabled object's versions (newest first). Each version is a separate object addressed by its
      // object ID, so they are read one at a time -- there is no container listing for them.
      async function enumerateVersions(url) {
        var md = (await getLeaf(url + '?metadata')).rep.metadata || {};
        var current = md.cdmi_version_current || null, idBase = objectIdBase(url);
        function at(id) { return idBase + 'cdmi_objectid/' + enc(id); }
        var out = [], seen = {}, queue = (md.cdmi_version_oldest || []).slice(), LIMIT = 200, n = 0;
        while (queue.length && n < LIMIT) {
          var id = queue.shift(); if (!id || seen[id]) continue; seen[id] = 1; n++;
          try {
            var vm = (await getRep(at(id) + '?metadata', T_OBJECT)).rep.metadata || {};
            out.push({ url: at(id), when: vm.cdmi_mtime || vm.cdmi_ctime || null, size: (vm.cdmi_size != null && isFinite(+vm.cdmi_size)) ? +vm.cdmi_size : null, current: id === current });
            (vm.cdmi_version_children || []).forEach(function (k) { queue.push(k); });
          } catch (e) { out.push({ url: at(id), when: null, size: null, current: id === current }); }
        }
        out.sort(function (a, b) { return (b.when ? +new Date(b.when) : 0) - (a.when ? +new Date(a.when) : 0); });
        return out;
      }
      async function browseVersions(fileTarget) {
        vmode = true; rows.textContent = ''; clearSel();
        where.textContent = 'Versions of ' + fileTarget.name;
        makeRow('container', '\u2190 back', false, { type: 'up', open: function () { browse(at); } });
        var note = h('p', { text: 'Reading versions \u2026' }); rows.appendChild(note);
        var vers;
        try { vers = await enumerateVersions(fileTarget.url); }
        catch (e) { note.textContent = 'Could not read versions: ' + (e && e.message || e); return; }
        note.remove();
        if (!vers.length) { rows.appendChild(h('p', { class: 'empty', text: 'No versions are recorded.' })); return; }
        vers.forEach(function (v) {
          var label = whenLabel(v.when).replace('\u2014', 'undated') + (v.size != null ? '  \u00b7  ' + sizeLabel(v.size) : '') + (v.current ? '   (current)' : '');
          makeRow('object', label, false, { type: 'version', name: fileTarget.name, url: v.url, open: function () { finish(v.url); } });
        });
      }
      cancel.addEventListener('click', function () { w.close(); });
      var start = (opts.startURI && locOfURL(opts.startURI)) || (function () { var hd = homeDisk(); return hd ? { base: hd.base, name: hd.name, segs: [] } : null; })() || (disks.length === 1 ? { base: disks[0].base, name: disks[0].name, segs: [] } : null);
      browse(start);
    });
  }

  function signInDialog(why) {
    return new Promise(function (resolve) {
      var n = ++uid, methods = (CD.caps && CD.caps.cdmi_authentication_methods) || ['basic', 'bearer'];
      methods = methods.filter(function (m) { return m === 'basic' || m === 'bearer'; }); if (!methods.length) methods = ['basic', 'bearer'];
      var mode = methods[0], done = false;
      // Sign in with the full user@domain. The domain is this server's own host name, e.g. alice@snia.local; the field
      // is pre-filled with the "@domain" suffix so the user types only their name before it. The controller qualifies
      // the account with its realm, so only the name before the "@" is presented as the Basic credential.
      var loginDomain = ''; try { loginDomain = new URL(CD.origin).hostname; } catch (e) {}
      var user = field('fvu' + n, 'User', loginDomain ? '@' + loginDomain : ''), pass = field('fvp' + n, 'Password', '', 'password'), tok = field('fvt' + n, 'Token', '', 'password');
      if (loginDomain) { user.input.placeholder = 'user@' + loginDomain;
        // The name goes before the pre-filled "@domain", so put the caret at the start when the field is entered.
        user.input.addEventListener('focus', function () { if (user.input.value.charAt(0) === '@') { try { user.input.setSelectionRange(0, 0); } catch (e) {} } });
      }
      var status = h('p', { style: 'min-height:1em;margin:0;color:#b00020', text: '' });
      var radios = h('div', { class: 'fv-row' }, [h('b', { text: 'Method' })].concat(methods.map(function (m) {
        var id = 'fvm' + n + m, r = h('input', { type: 'radio', name: 'fvm' + n, id: id });
        r.checked = m === mode; r.addEventListener('change', function () { mode = m; sync(); });
        return h('span', { class: 'fv-row', style: 'gap:4px' }, [r, h('label', { for: id, text: m === 'basic' ? 'Basic' : 'Bearer' })]);
      })));
      function sync() { user.row.style.display = pass.row.style.display = mode === 'basic' ? '' : 'none'; tok.row.style.display = mode === 'bearer' ? '' : 'none'; status.textContent = ''; }
      var cancel = h('button', { class: 'fv-btn', type: 'button', text: 'Cancel' }), ok = h('button', { class: 'fv-btn', type: 'button', text: 'Sign in' });
      var w = new Win({ title: 'Sign in \u00B7 ' + CD.origin, w: 440, h: 290, center: true, escCloses: true, onClose: function () { if (!done) resolve(false); },
        content: h('div', { class: 'fv-form' }, [h('p', { text: (why ? why + ' ' : '') + 'Credentials are kept in memory for this page only and are handed to applications you run.' }), radios, user.row, pass.row, tok.row, status, h('div', { class: 'fv-row end' }, [cancel, ok])]) });
      sync();
      function submit() {
        if (mode === 'basic') {
          var val = user.input.value.trim();
          // Require the full user@domain when a domain is known, and present only the name before the "@".
          var name = val;
          if (loginDomain) {
            var at = val.lastIndexOf('@');
            if (at <= 0 || at === val.length - 1 || /\s/.test(val)) { status.textContent = 'Sign in with your full user@domain, e.g. alice@' + loginDomain + '.'; return; }
            name = val.slice(0, at);
          }
          if (!name) { status.textContent = 'Enter a user name.'; return; }
          CD.auth = 'Basic ' + btoa(unescape(encodeURIComponent(name + ':' + pass.input.value)));
        } else {
          if (!tok.input.value.trim()) { status.textContent = 'Enter a token.'; return; }
          CD.auth = 'Bearer ' + tok.input.value.trim();
        }
        done = true; w.close(); resolve(true);
      }
      ok.addEventListener('click', submit); cancel.addEventListener('click', function () { w.close(); });
      w.el.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' && ev.target.tagName === 'INPUT') submit(); });
    });
  }

  function connectDialog(reason) {
    var n = ++uid, base = field('fvb' + n, 'Base URI', '/cdmi/3.0.0/'), name = field('fvn' + n, 'Disk name', 'cloud');
    var status = h('p', { text: '' });
    var cancel = h('button', { class: 'fv-btn', type: 'button', text: 'Cancel' }), ok = h('button', { class: 'fv-btn', type: 'button', text: 'Mount' });
    var w = new Win({ title: 'Connect to CDMI server', w: 520, h: 290, center: true, escCloses: true,
      content: h('div', { class: 'fv-form' }, [h('p', { text: reason || 'Mount a base URI as a disk. A base URI at another origin is mounted too, once it answers a CORS preflight.' }), base.row, name.row, status, h('div', { class: 'fv-row end' }, [cancel, ok])]) });
    async function submit() {
      var url;
      try { url = new URL(base.input.value.trim(), CD.origin + '/').href; } catch (e) { status.textContent = 'That is not a URI.'; return; }
      if (!/\/$/.test(url)) url += '/';                       // a base URI ends with "/"
      if (!isTLS(url)) { status.textContent = 'Only https: base URIs can be mounted: this desktop connects over TLS only.'; return; }
      var cross = !sameOrigin(url);
      status.textContent = 'Reading ' + url + ' \u2026';
      try {
        // A cross-origin base is vouched (CORS preflight) before it is read, so the credential may travel to it.
        if (cross) await vouchedOrigin(url);
        var got = await getRep(url + '?objectType&objectName', ACCEPT_DIR);
        if (got.rep.objectType && got.rep.objectType !== T_CONTAINER) throw new Error('that is not a container object');
        addMount({ name: name.input.value.trim() || 'cloud', base: url, manual: true, crossOrigin: cross }); w.close();
      } catch (e) { status.textContent = 'Could not read it: ' + e.message; }
    }
    ok.addEventListener('click', submit); cancel.addEventListener('click', function () { w.close(); });
    w.el.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' && ev.target.tagName === 'INPUT') submit(); });
    return w;
  }

  function textWindow(title, text, o) {
    o = o || {};
    return new Win({ title: title, icon: o.icon || 'object', w: o.w || 560, h: o.h || 380,
      content: h('div', { style: 'flex:1;display:flex;flex-direction:column;min-height:0' }, [h('pre', { class: 'fv-text' + (o.hex ? ' hex' : ''), text: text, tabindex: '0' }), o.status ? h('div', { class: 'fv-status', text: o.status }) : null]) });
  }


  /* ------------------------------------------------------------------ defining exports and imports

     An object's "exports" field is a set of named entries, each presenting it over another protocol. Its "imports"
     field is an ordered stack of layers, uppermost first: each brings in a namespace (or, for a data object or
     a queue, a value or a stream of messages) from elsewhere, and the entry of type "self" stands for what the
     object itself holds. The order matters, so the dialog shows a stack that can be reordered, and one layer at
     most is the write target.

     What each type of entry may hold comes from ENTRY_SCHEMAS, built from the field tables of the specification.
     Fields the server populates are shown as status and never sent back. An entry can always be edited as JSON too,
     for anything the tables do not cover. Which types a server offers for an object is read from the object's own
     capabilities (cdmi_export_container_http and the like); the others stay available, marked as not offered. */
  var ENTRY_SCHEMAS = /*SCHEMA-START*/{"exports":{"CDMI":{"on":["container"],"f":[{"n":"origins","k":"l","h":"The origins at which the export is served, each in the form the specification requires of the field of that name","r":1},{"n":"path","k":"s","h":"The root path beneath which the exported container object is served, in percent-decoded form, in the form the…","r":1},{"n":"protocol","k":"l","h":"The versions of this document the CDMI server serves through this export, each in the form the specification gives…"},{"n":"read_only","k":"b","h":"Where this field contains \"true\", the CDMI server shall refuse through this export every operation that creates,…","d":"false"},{"n":"base_uri","k":"s","h":"CDMI server populated, and ignored where a CDMI client supplies it","srv":1}]},"SMB":{"on":["container"],"f":[{"n":"protocol","k":"m","h":"The SMB protocol versions the SMB server shall offer for this share, as provided by the cdmi_export_smb_versions…","r":1,"o":["SMB2","SMB2.1","SMB3","SMB3.0.2","SMB3.1.1"]},{"n":"auth_methods","k":"m","h":"The authentication methods the SMB server shall offer and accept for this share","o":["kerberos","ntlmv2","anonymous"]},{"n":"sharename","k":"s","h":"The SMB share name under which the CDMI container object shall be published","r":1},{"n":"comment","k":"s","h":"A human-readable description of the share that SMB clients may display in browse lists and share selection dialogs"},{"n":"domain","k":"s","h":"The Active Directory domain name or workgroup name used for authenticating SMB clients"},{"n":"domain_servers","k":"l","h":"A list of hostnames or IP addresses of domain controllers or Kerberos Key Distribution Centers (KDCs) for the domain…"},{"n":"usermap","k":"j","h":"Authentication credential mapping of user names between CDMI and SMB identity domains"},{"n":"groupmap","k":"j","h":"Authentication credential mapping of group names between CDMI and SMB identity domains"},{"n":"rw_hosts","k":"l","h":"A list of hostnames, IP addresses, or CIDR ranges whose authenticated SMB clients may access the container with…"},{"n":"ro_hosts","k":"l","h":"A list of hostnames, IP addresses, or CIDR ranges whose authenticated SMB clients may access the container with…"},{"n":"root_hosts","k":"l","h":"A list of hostnames, IP addresses, or CIDR ranges whose authenticated SMB clients shall be granted unrestricted…"},{"n":"signing","k":"e","h":"Controls SMB message signing for this share","o":["disabled","required"],"d":"disabled"},{"n":"encryption","k":"e","h":"Controls SMB transport encryption for this share","o":["disabled","required"],"d":"disabled"},{"n":"access_based_enumeration","k":"b","h":"Controls access based enumeration (ABE) for this share","d":"false"},{"n":"oplocks","k":"b","h":"Controls opportunistic locking (oplocks) and SMB2 leasing for this share","d":"true"},{"n":"continuous_availability","k":"b","h":"Controls continuous availability (CA) for this share, enabling persistent file handles","d":"false"},{"n":"dfs_enabled","k":"b","h":"Controls whether this share participates in a Distributed File System (DFS) namespace managed by the SMB server","d":"false"},{"n":"shadow_copies","k":"b","h":"Controls whether point-in-time snapshots of the container are presented to SMB clients through the Previous Versions…","d":"false"},{"n":"max_connections","k":"s","h":"The maximum number of simultaneous SMB sessions permitted on this share","d":"0"},{"n":"server_addresses","k":"l","h":"A list of hostnames or IP addresses through which SMB clients may reach this share","srv":1}]},"NFS":{"on":["container"],"f":[{"n":"path","k":"s","h":"The path within the namespace of the NFS server at which the CDMI container object shall be provided as an NFS…","r":1},{"n":"protocol","k":"m","h":"The NFS protocol versions the NFS server shall offer for this export, as provided by the cdmi_export_nfs_versions…","r":1,"o":["NFSv3","NFSv4","NFSv4.1","NFSv4.2"]},{"n":"usermap","k":"j","h":"Authentication credential mapping of user names between CDMI and NFS identity domains"},{"n":"groupmap","k":"j","h":"Authentication credential mapping of group names between CDMI and NFS identity domains"},{"n":"security_flavors","k":"m","h":"The security flavors the NFS server shall offer and accept for this export","o":["sys","krb5","krb5i","krb5p","tls"]},{"n":"domain","k":"s","h":"The NFS domain name used for NFSv4 user and group identity mapping"},{"n":"domain_servers","k":"l","h":"A list of hostnames or IP addresses that function as name servers for the domain specified in domain"},{"n":"squash","k":"e","h":"Controls how the NFS server maps the identities of privileged NFS clients","o":["root_squash","no_root_squash","all_squash"],"d":"root_squash"},{"n":"anon_uid","k":"s","h":"The numeric UID to which client UIDs are mapped when squashing is applied","d":"65534"},{"n":"anon_gid","k":"s","h":"The numeric GID to which client GIDs are mapped when squashing is applied","d":"65534"},{"n":"root_hosts","k":"l","h":"A list of hostnames, IP addresses, or CIDR ranges that may access the container without root squashing, regardless…"},{"n":"rw_hosts","k":"l","h":"A list of hostnames, IP addresses, or CIDR ranges that may access the container with read-write permissions"},{"n":"ro_hosts","k":"l","h":"A list of hostnames, IP addresses, or CIDR ranges that may access the container with read-only permissions"},{"n":"recurse","k":"b","h":"Controls whether CDMI imports encountered within the exported directory tree shall be followed and their contents…","d":"false"},{"n":"write_mode","k":"e","h":"Controls the write behaviour provided by the NFS server","o":["sync","async"],"d":"sync"},{"n":"subtree_check","k":"b","h":"Controls whether the NFS server performs subtree checking for this export","d":"false"},{"n":"rdma_enabled","k":"b","h":"Controls whether the NFS server accepts client connections over RDMA transports as defined in RFC 8267 for this export","d":"false"},{"n":"server_addresses","k":"l","h":"A list of hostnames or IP addresses through which NFS clients may reach this export","srv":1}]},"HTTP":{"on":["container"],"f":[{"n":"origins","k":"l","h":"The origins at which the export is served","r":1},{"n":"path","k":"s","h":"The URI path beneath which the exported container object is served, in percent-decoded form","r":1},{"n":"protocol","k":"l","h":"The HTTP protocol versions the CDMI server offers, as provided by the cdmi_export_http_versions capability"},{"n":"read_only","k":"b","h":"Permitted values are \"true\" and \"false\"; the default shall be \"true\"","d":"true"},{"n":"anonymous_read","k":"b","h":"Permitted values are \"true\" and \"false\"; the default shall be \"false\"","d":"false"},{"n":"auth_method","k":"e","h":"The HTTP authentication scheme by which a request is associated with a principal: \"anonymous\" (the CDMI server shall…","d":"anonymous","o":["anonymous","basic","digest","bearer","krb5","x509"]},{"n":"certificates","k":"j","h":"References to certificates the CDMI server shall present for \"https\" origins of the entry"},{"n":"index_document","k":"s","h":"The name of a child data object that the CDMI server shall serve in response to a GET or HEAD request for a…"},{"n":"error_document","k":"s","h":"The path, relative to the exported container object, of a data object whose value the CDMI server shall serve as the…"},{"n":"max_age","k":"s","h":"The freshness lifetime, in seconds, that the CDMI server shall set on a response that transports a value or a…","d":"0"},{"n":"origins_provided","k":"l","h":"The values of origins at which the export is currently served","srv":1},{"n":"certificate_expiry","k":"j","h":"For each \"https\" origin in origins_provided, the CDMI server shall report an element with an origin sub-field and an…","srv":1}]},"S3":{"on":["container"],"f":[{"n":"protocol","k":"l","h":"The S3 protocol versions the CDMI server offers, as provided by the cdmi_export_s3_versions capability"},{"n":"anonymous_read","k":"b","h":"Controls whether unauthenticated S3 requests may read objects from this bucket","d":"false"},{"n":"bucket_name","k":"s","h":"The name of the S3 bucket through which the exported container is presented","r":1},{"n":"region","k":"s","h":"The region name that S3 clients shall use when computing request signatures for this bucket, and that the CDMI…"},{"n":"addressing_style","k":"e","h":"The request addressing styles at which the bucket is reachable","o":["path","virtual_hosted","both"],"d":"path"},{"n":"tls","k":"e","h":"Controls whether requests to this bucket shall be protected by TLS. Permitted values are \"disabled\" (requests are…","o":["disabled","required"],"d":"required"},{"n":"versioning","k":"b","h":"Controls whether the bucket is presented as version-enabled, such that each write to a key preserves the previous…","d":"false"},{"n":"multipart_expiry","k":"s","h":"The period after which the CDMI server shall abort a multipart upload that has been neither completed nor aborted,…"},{"n":"endpoints","k":"l","h":"A list of endpoints at which the bucket may be reached, each expressed as an absolute URI with a scheme of https or…","srv":1},{"n":"multipart_uploads","k":"s","h":"The number of multipart uploads initiated through this export that have been neither completed nor aborted, as a…","srv":1},{"n":"multipart_uploads_size","k":"s","h":"The total size, in bytes, of the parts held for those uploads, as a decimal integer","srv":1}]},"iSCSI":{"on":["object"],"f":[{"n":"protocol","k":"l","h":"The iSCSI protocol versions the CDMI server offers, as provided by the cdmi_export_iscsi_versions capability"},{"n":"read_only","k":"b","h":"Controls whether the logical unit is write protected for all initiators","d":"false"},{"n":"auth_method","k":"e","h":"The authentication method the target node shall require during iSCSI login","o":["none","chap","mutual_chap"],"d":"none"},{"n":"target_alias","k":"s","h":"A human-readable alias for the target node, presented to initiators as the iSCSI TargetAlias key during login…"},{"n":"block_size","k":"e","h":"The logical block length in bytes that the logical unit shall report in the READ CAPACITY response","o":["512","4096"],"d":"4096"},{"n":"thin_provisioned","k":"b","h":"Controls whether the logical unit is presented as thin provisioned, such that logical blocks that have never been…","d":"true"},{"n":"write_cache_enabled","k":"b","h":"Controls the write behaviour of the logical unit","d":"false"},{"n":"reservations","k":"b","h":"Controls whether the logical unit accepts reservation commands, by which clustered hosts coordinate access to the…","d":"false"},{"n":"rw_initiators","k":"l","h":"A list of iSCSI initiator names that may log in to the target node and access the logical unit with read-write…"},{"n":"ro_initiators","k":"l","h":"A list of iSCSI initiator names that may log in to the target node and access the logical unit with read-only…"},{"n":"auth_username","k":"s","h":"The CHAP name the target node shall expect the initiator to present during login"},{"n":"auth_secret_id","k":"j","h":"A credential reference, a JSON object as specified in the specification, addressing a managed object of type Secret…"},{"n":"mutual_auth_username","k":"s","h":"The CHAP name the target node shall present to the initiator when authenticating itself"},{"n":"mutual_auth_secret_id","k":"j","h":"A credential reference, a JSON object as specified in the specification, addressing a managed object of type Secret…"},{"n":"header_digest","k":"e","h":"Controls iSCSI header digest negotiation for connections to this target node","o":["disabled","required"],"d":"disabled"},{"n":"data_digest","k":"e","h":"Controls iSCSI data digest negotiation for connections to this target node","o":["disabled","required"],"d":"disabled"},{"n":"ipsec","k":"e","h":"Controls IPsec transport security for connections to this target node, as defined in RFC 7146. Permitted values are…","o":["disabled","required"],"d":"disabled"},{"n":"isns_servers","k":"l","h":"A list of hostnames or IP addresses of Internet Storage Name Service (iSNS) servers with which the target node shall…"},{"n":"max_sessions","k":"s","h":"The maximum number of simultaneous iSCSI sessions permitted to this target node","d":"0"},{"n":"target_name","k":"s","h":"The iSCSI name of the target node generated by the CDMI server, in iqn, eui, or naa format as defined in RFC 3721…","srv":1},{"n":"portals","k":"l","h":"A list of network portals through which initiators may reach this target node, each expressed as an IP address or…","srv":1},{"n":"logical_unit_number","k":"s","h":"The logical unit number at which the data object is presented within the target node, expressed as a decimal string.","srv":1},{"n":"logical_unit_name","k":"s","h":"The globally unique logical unit name reported by the logical unit in VPD page 0x83, expressed as a hexadecimal…","srv":1},{"n":"active_sessions","k":"s","h":"The current count of iSCSI sessions established with this target node, expressed as a decimal string","srv":1}]},"NVMe":{"on":["object"],"f":[{"n":"protocol","k":"l","h":"The NVMe protocol versions the CDMI server offers, as provided by the cdmi_export_nvme_versions capability"},{"n":"read_only","k":"b","h":"Controls whether the namespace is write protected for all hosts","d":"false"},{"n":"auth_method","k":"e","h":"The authentication method the subsystem shall require during fabrics connection establishment","o":["none","dhchap","mutual_dhchap"],"d":"none"},{"n":"transport","k":"e","h":"The NVMe over Fabrics transport over which the subsystem shall be made reachable","o":["tcp","rdma"],"d":"tcp"},{"n":"block_size","k":"e","h":"The LBA data size in bytes that the namespace shall report in its supported LBA format","o":["512","4096"],"d":"4096"},{"n":"thin_provisioned","k":"b","h":"Controls whether the namespace is presented as thin provisioned, such that logical blocks that have never been…","d":"true"},{"n":"write_cache_enabled","k":"b","h":"Controls the write behaviour of the namespace","d":"false"},{"n":"reservations","k":"b","h":"Controls whether the namespace accepts reservation commands, by which clustered hosts coordinate access to the…","d":"false"},{"n":"rw_initiators","k":"l","h":"A list of NVMe host NQNs that may connect to the subsystem and access the namespace with read-write permissions"},{"n":"ro_initiators","k":"l","h":"A list of NVMe host NQNs that may connect to the subsystem and access the namespace with read-only permissions"},{"n":"psk","k":"j","h":"The pre-shared keys of the hosts permitted to connect, one element for each"},{"n":"auth_secret_id","k":"j","h":"A credential reference, a JSON object as specified in the specification, addressing a managed object of type Secret…"},{"n":"mutual_auth_secret_id","k":"j","h":"A credential reference, a JSON object as specified in the specification, addressing a managed object of type Secret…"},{"n":"dhchap_hash","k":"e","h":"The hash function the subsystem shall offer for DH-HMAC-CHAP authentication","o":["sha256","sha384","sha512"],"d":"sha256"},{"n":"dhchap_dhgroup","k":"e","h":"The Diffie-Hellman group the subsystem shall offer for DH-HMAC-CHAP authentication","o":["null","ffdhe2048","ffdhe3072","ffdhe4096","ffdhe6144","ffdhe8192"],"d":"ffdhe2048"},{"n":"header_digest","k":"e","h":"Controls NVMe/TCP PDU header digest negotiation for connections to this subsystem","o":["disabled","required"],"d":"disabled"},{"n":"data_digest","k":"e","h":"Controls NVMe/TCP PDU data digest negotiation for connections to this subsystem","o":["disabled","required"],"d":"disabled"},{"n":"tls","k":"e","h":"Controls TLS transport security for connections to this subsystem","o":["disabled","required"],"d":"disabled"},{"n":"discovery_controllers","k":"l","h":"A list of hostnames or IP addresses of Centralized Discovery Controllers with which the subsystem shall register its…"},{"n":"max_controllers","k":"s","h":"The maximum number of simultaneous controllers the subsystem shall permit to be associated with hosts","d":"0"},{"n":"subsystem_nqn","k":"s","h":"The NVMe Qualified Name of the subsystem generated by the CDMI server (e.g.,…","srv":1},{"n":"ports","k":"j","h":"A list of subsystem ports through which hosts may reach this subsystem, as described in the specification.","srv":1},{"n":"namespace_id","k":"s","h":"The namespace identifier at which the data object is presented within the subsystem, expressed as a decimal string.","srv":1},{"n":"nguid","k":"s","h":"The globally unique namespace identifier reported by the namespace, expressed as a hexadecimal string (e.g.,…","srv":1},{"n":"active_controllers","k":"s","h":"The current count of controllers associated with hosts on this subsystem, expressed as a decimal string","srv":1}]},"MQTT":{"on":["queue"],"f":[{"n":"protocol","k":"l","h":"The MQTT protocol versions the CDMI server offers, as provided by the cdmi_export_mqtt_versions capability"},{"n":"broker_uri","k":"s","h":"The URI of the MQTT broker to which the CDMI server shall connect","r":1},{"n":"topic","k":"s","h":"The MQTT topic name to which the CDMI server shall publish queue values","r":1},{"n":"client_id","k":"s","h":"The MQTT client identifier the CDMI server shall present to the broker during connection","r":1},{"n":"reconnect_strategy","k":"e","h":"The strategy used when connectivity between the CDMI server and the MQTT broker is lost","o":["fixed","linear","exponential"],"d":"exponential"},{"n":"qos","k":"e","h":"The MQTT Quality of Service level for all PUBLISH operations","o":["0","1","2"],"d":"1"},{"n":"retain","k":"b","h":"When set to \"true\", published MQTT messages shall have the MQTT retain flag set, instructing the broker to retain…","d":"false"},{"n":"clean_session","k":"b","h":"Controls the MQTT clean session flag (MQTT 3.1.1) or clean start flag (MQTT 5.0)","d":"true"},{"n":"keep_alive_interval","k":"s","h":"The MQTT keep-alive interval in seconds"},{"n":"dequeue_on_publish","k":"b","h":"When set to \"true\", each queue value shall be removed from the CDMI queue object only after the CDMI server has…","d":"false"},{"n":"username","k":"s","h":"The username credential the CDMI server shall include in the MQTT CONNECT packet when connecting to the broker"},{"n":"password_secret_id","k":"j","h":"A credential reference, a JSON object as specified in the specification, addressing a managed object of type Secret…"},{"n":"refresh_interval","k":"s","h":"The interval, in seconds, at which the CDMI server resolves the credential references of this entry again, as…","d":"0"},{"n":"tls","k":"j","h":"A JSON object containing TLS configuration sub-fields governing the security of the MQTT broker connection, as…"},{"n":"will","k":"j","h":"A JSON object containing Last Will and Testament (LWT) configuration sub-fields, as described in table the specification"},{"n":"session_expiry_interval","k":"s","h":"(MQTT 5.0 only) The number of seconds the broker retains session state after the CDMI server disconnects, as sent by…","d":"0"},{"n":"message_expiry_interval","k":"s","h":"(MQTT 5.0 only) The number of seconds after which an undelivered message expires in the broker, as sent by the CDMI…"},{"n":"content_type","k":"s","h":"(MQTT 5.0 only) A UTF-8 string describing the MIME content type of published message payloads, transported as the…"},{"n":"response_topic","k":"s","h":"(MQTT 5.0 only) An MQTT topic name included as the Response Topic property in each MQTT PUBLISH packet, indicating…"},{"n":"user_properties","k":"j","h":"(MQTT 5.0 only) A list of user-defined key-value pairs included as User Property entries in each MQTT PUBLISH packet"},{"n":"connected","k":"b","h":"Indicates whether the CDMI server currently has an active MQTT connection to the broker","srv":1},{"n":"messages_published","k":"s","h":"The cumulative count of MQTT messages successfully published to the broker since the export entry was created.","srv":1},{"n":"messages_pending","k":"s","h":"The current count of enqueued CDMI values not yet published to the broker plus the current count of MQTT messages…","srv":1},{"n":"messages_dropped","k":"s","h":"The current count of CDMI values that were unable to be delivered to the MQTT broker and are not retried.","srv":1},{"n":"last_connected","k":"s","h":"The timestamp of the most recent successful broker connection, in the form defined in the specification.","srv":1}]}},"imports":{"CDMI":{"on":["container"],"u":"https://host/cdmi/3.0.0/container/ or /container/ on this server","f":[{"n":"protocol","k":"l","h":"The CDMI protocol versions the CDMI server may negotiate with the import source, in order of preference, with the…"},{"n":"auth_method","k":"e","h":"The authentication method the CDMI server uses with the import source, where the identity mode is \"service\"","c":1,"o":["bearer","basic"]},{"n":"username","k":"s","h":"The user name the CDMI server presents, where the \"auth_method\" field contains \"basic\"","c":1},{"n":"resource","k":"s","h":"The resource identifier, as defined in RFC 8707 , for which the CDMI server requests an access token to present to…"},{"n":"preserve_objectid","k":"b","h":"Whether the object ID reported by the import source is reported for each object presented","d":"true"}]},"NFS":{"on":["container"],"u":"nfs://host/export/path/","f":[{"n":"protocol","k":"l","h":"The NFS protocol versions the CDMI server may negotiate with the import source, in order of preference, with the…"},{"n":"principal","k":"s","h":"The Kerberos principal name the CDMI server presents, where the identity mode is \"service\" and the security flavour…","c":1},{"n":"security","k":"e","h":"The security flavour the CDMI server shall use, as specified in RFC 2203 and RFC 7530 . Permitted values are \"krb5\"…","o":["krb5","krb5i","krb5p","sys"],"d":"krb5p"},{"n":"transport","k":"e","h":"The transport the CDMI server shall use to reach the import source","o":["tcp","rdma"],"d":"tcp"},{"n":"port","k":"s","h":"The port on which the import source is reached, expressed as a decimal string","d":"2049"},{"n":"follow_symlinks","k":"b","h":"Whether a symbolic link in the imported namespace is resolved by the CDMI server","d":"false"},{"n":"anon_uid","k":"s","h":"The numeric user and group identifiers the CDMI server presents where the identity mode is \"service\" and the…"},{"n":"anon_gid","k":"s","h":"The numeric user and group identifiers the CDMI server presents where the identity mode is \"service\" and the…"}]},"S3":{"on":["container"],"u":"https://s3.example.com/bucket/prefix/","f":[{"n":"protocol","k":"l","h":"The S3 protocol versions the CDMI server may negotiate with the import source, in order of preference, with the…"},{"n":"access_key_id","k":"s","h":"The access key identifier the CDMI server presents with every signed request, where the identity mode is \"service\"","c":1},{"n":"region","k":"s","h":"The region for which the CDMI server computes the request signature"},{"n":"addressing_style","k":"e","h":"The style in which the CDMI server addresses the bucket when it issues a request","o":["path","virtual_hosted"],"d":"virtual_hosted"},{"n":"listing_max_age","k":"s","h":"The maximum age of a listing of the import source that the CDMI server may use to enumerate the children of a…","d":"PT0S"},{"n":"folder_markers","k":"b","h":"Whether the CDMI server creates a zero-length key ending with \"/\" when it creates a container object through the import","d":"true"},{"n":"object_lock","k":"b","h":"Whether the CDMI server presents the Object Lock configuration of an object of the import source as retention…","d":"false"}]},"SMB":{"on":["container"],"u":"smb://host/share/path/","f":[{"n":"protocol","k":"l","h":"The SMB protocol versions the CDMI server may negotiate with the import source, in order of preference, with the…"},{"n":"auth_method","k":"e","h":"The authentication method the CDMI server shall use with the import source","o":["kerberos","ntlmv2"],"d":"kerberos"},{"n":"username","k":"s","h":"The user name the CDMI server presents when it establishes a session, where the identity mode is \"service\"","c":1},{"n":"domain","k":"s","h":"The Active Directory domain or Kerberos realm in which the import source and the principals that reach it are named"},{"n":"domain_servers","k":"l","h":"Hostnames or addresses of domain controllers or Kerberos Key Distribution Centers for the domain specified in the…"},{"n":"signing","k":"e","h":"Whether the CDMI server shall require message signing on its connections to the import source","o":["disabled","required"],"d":"required"},{"n":"encryption","k":"e","h":"Whether the CDMI server shall require transport encryption on its connections to the import source","o":["disabled","required"],"d":"required"},{"n":"max_sessions","k":"s","h":"The maximum number of simultaneous SMB sessions the CDMI server shall hold to the import source for this import,…","d":"0"},{"n":"follow_reparse","k":"b","h":"Whether a reparse point in the imported namespace is resolved by the CDMI server","d":"false"}]},"image":{"on":["container"],"u":"the URI of the data object that holds the file system","f":[{"n":"filesystem","k":"s","h":"The file system the CDMI server shall interpret in the value of the import source, as required by the specification","r":1},{"n":"partition","k":"s","h":"The partition of the partition table held in the value of the import source within which the file system is held,…"},{"n":"offset","k":"s","h":"The byte offset within the value of the import source at which the file system begins, expressed as a non-negative…"},{"n":"source_objectid","k":"s","h":"The object ID of the data object addressed by the \"import_uri\" field, in the form defined in the specification","srv":1}]},"iSCSI":{"on":["container"],"u":"iscsi://host[:port]/target-name/lun","f":[{"n":"protocol","k":"l","h":"The iSCSI protocol versions the CDMI server may negotiate with the import source, in order of preference, with the…"},{"n":"auth_method","k":"e","h":"The authentication method the CDMI server shall use with the target","o":["none","chap"],"d":"chap"},{"n":"filesystem","k":"s","h":"The file system the CDMI server shall interpret on the logical unit, as required by the specification","c":1},{"n":"initiator_name","k":"s","h":"The iSCSI initiator name the CDMI server shall present to the target, as specified in RFC 3721 . Where absent, the…"},{"n":"auth_username","k":"s","h":"The CHAP username the CDMI server shall present to the target"},{"n":"auth_secret_id","k":"j","h":"A credential reference, a JSON object as specified in the specification, addressing a managed object of type Secret…"},{"n":"mutual_auth_username","k":"s","h":"The CHAP username the CDMI server shall require the target to present to it"},{"n":"mutual_auth_secret_id","k":"j","h":"A credential reference, a JSON object as specified in the specification, addressing a managed object of type Secret…"},{"n":"header_digest","k":"e","h":"Whether the CDMI server shall require an iSCSI header digest on its connections to the target","o":["none","crc32c"],"d":"none"},{"n":"data_digest","k":"e","h":"Whether the CDMI server shall require an iSCSI data digest on its connections to the target","o":["none","crc32c"],"d":"none"},{"n":"ipsec","k":"e","h":"Whether the CDMI server shall require IPsec protection of its connections to the target, as specified in RFC 7146 .…","o":["disabled","required"],"d":"disabled"},{"n":"portals_provided","k":"l","h":"The portals at which the CDMI server currently reaches the target, each in the form host:port","srv":1}]},"NVMe":{"on":["container"],"u":"nvme://host[:port]/subsystem-nqn/namespace","f":[{"n":"protocol","k":"l","h":"The NVMe protocol versions the CDMI server may negotiate with the import source, in order of preference, with the…"},{"n":"auth_method","k":"e","h":"The authentication method the CDMI server shall use with the subsystem","o":["none","dhchap"],"d":"dhchap"},{"n":"filesystem","k":"s","h":"The file system the CDMI server shall interpret on the NVMe namespace, as required by the specification","c":1},{"n":"transport","k":"e","h":"The transport the CDMI server shall use to reach the subsystem","o":["tcp","rdma"],"d":"tcp"},{"n":"host_nqn","k":"s","h":"The NVMe Qualified Name the CDMI server shall present to the subsystem as its host NQN. Where absent, the CDMI…"},{"n":"auth_secret_id","k":"j","h":"A credential reference, a JSON object as specified in the specification, addressing a managed object of type Secret…"},{"n":"mutual_auth_secret_id","k":"j","h":"A credential reference, a JSON object as specified in the specification, addressing a managed object of type Secret…"},{"n":"dhchap_hash","k":"e","h":"The hash function used for DH-HMAC-CHAP. Permitted values are \"sha256\", \"sha384\", and \"sha512\"","o":["sha256","sha384","sha512"],"d":"sha256"},{"n":"dhchap_dhgroup","k":"e","h":"The Diffie-Hellman group used for DH-HMAC-CHAP, as specified in RFC 7919 . Permitted values are \"null\", \"ffdhe2048\",…","o":["null","ffdhe2048","ffdhe3072","ffdhe4096","ffdhe6144","ffdhe8192"],"d":"ffdhe3072"},{"n":"header_digest","k":"e","h":"Whether the CDMI server shall require an NVMe/TCP header digest on its connections to the subsystem","o":["none","crc32c"],"d":"none"},{"n":"data_digest","k":"e","h":"Whether the CDMI server shall require an NVMe/TCP data digest on its connections to the subsystem","o":["none","crc32c"],"d":"none"},{"n":"tls","k":"e","h":"Whether the CDMI server shall require TLS protection of its connections to the subsystem","o":["disabled","required"],"d":"disabled"},{"n":"controllers_provided","k":"l","h":"The controllers of the subsystem to which the CDMI server currently holds a connection for this import, each in the…","srv":1}]},"MQTT":{"on":["queue"],"u":"mqtts://broker/topic/filter","f":[{"n":"protocol","k":"l","h":"The MQTT protocol versions the CDMI server may negotiate with the broker, in order of preference, as provided by the…"},{"n":"client_id","k":"s","h":"The MQTT client identifier the CDMI server shall present to the broker"},{"n":"qos","k":"e","h":"The maximum quality of service the CDMI server shall request when it subscribes","o":["0","1","2"],"d":"1"},{"n":"clean_session","k":"b","h":"Whether the CDMI server shall request a clean session when it connects","d":"false"},{"n":"keep_alive_interval","k":"s","h":"The MQTT keep alive interval in seconds, expressed as a non-negative decimal string","d":"60"},{"n":"username","k":"s","h":"The username the CDMI server shall present to the broker."},{"n":"password_secret_id","k":"j","h":"A credential reference, a JSON object as specified in the specification, addressing a managed object of type Secret…"},{"n":"refresh_interval","k":"s","h":"The interval, in seconds, at which the CDMI server resolves the credential references of this entry again, as…","d":"0"},{"n":"tls","k":"j","h":"The TLS configuration of the connection to the broker, in the form defined for the \"tls\" field of an MQTT export…"},{"n":"mimetype","k":"s","h":"The media type the CDMI server shall assign to each value it enqueues, as defined in the specification"},{"n":"value_transfer_encoding","k":"e","h":"The value transfer encoding the CDMI server shall assign to each value it enqueues","o":["utf-8","base64","json"],"d":"base64"},{"n":"connected","k":"b","h":"Whether the CDMI server currently holds a connection to the broker and an active subscription","srv":1},{"n":"messages_enqueued","k":"s","h":"The number of messages the CDMI server has enqueued to the queue object through this import since the import entry…","srv":1},{"n":"messages_dropped","k":"s","h":"The number of messages the CDMI server received and did not enqueue, expressed as a decimal string","srv":1}]},"self":{"on":["container"],"f":[]}},"exportCommon":[{"n":"disabled","k":"b","h":"Whether the export is administratively disabled","d":"false"},{"n":"active","k":"b","h":"Whether the export is established and is serving requests","srv":1},{"n":"last_problems","k":"j","h":"The conditions that currently prevent the export from being established, or that currently impair it","srv":1},{"n":"state_determined_time","k":"s","h":"The time at which the CDMI server last determined the state that the \"active\" and \"last_problems\" fields report, in…","srv":1}],"importCommon":[{"n":"write_enabled","k":"b","h":"Whether an operation that changes an object may be directed to this import","d":"false"},{"n":"disabled","k":"b","h":"Whether the import is administratively disabled","d":"false"},{"n":"required","k":"b","h":"Whether the objects of the importing object may be presented while this import is not active","d":"false"},{"n":"active","k":"b","h":"Whether the imported namespace is reachable and is being presented","srv":1},{"n":"last_problems","k":"j","h":"The conditions that currently prevent the import from being presented, or that currently impair it","srv":1},{"n":"state_determined_time","k":"s","h":"The time at which the CDMI server last determined the state that the \"active\" and \"last_problems\" fields report, in…","srv":1}],"importAddress":[{"n":"import_uri","k":"s","h":"The namespace to be imported, in the form defined by the subclause defining the import type","r":1},{"n":"identity_mode","k":"e","h":"How the CDMI server authenticates to the import source, as defined in the specification","o":["delegated","service"],"d":"delegated"},{"n":"credential_id","k":"j","h":"A credential reference, as specified in the specification, addressing the secret the CDMI server presents to the…"}]}/*SCHEMA-END*/;

  /* Define DAC: set or clear the two metadata items that place an object under a delegated access control provider --
     cdmi_dac_uri (the provider's https URL) and cdmi_dac_certificate (its JWK). An object carrying both is governed by
     that provider; removing them returns it to its own access control list. Offered only where the server publishes the
     cdmi_dac capability. */
  async function defineDacWindow(url) {
    var d = diskFor(url), label = d ? d.name + ':' + pathIn(d, url) : url, n = ++uid;
    var uri = field('fvdu' + n, 'Provider URI', '');
    uri.input.placeholder = 'https://host:port/decide';
    var certLabel = h('label', { for: 'fvdc' + n, text: 'Certificate' });
    var cert = h('textarea', { id: 'fvdc' + n, rows: '10', spellcheck: 'false',
      style: 'font:12px var(--mono);resize:vertical;width:100%;box-sizing:border-box;height:200px;padding:6px;background:#fff;color:#000;border:2px solid;border-color:var(--dk) var(--lt) var(--lt) var(--dk)', placeholder: 'the provider\u2019s certificate as a JWK (JSON), from dacd.ts --certificate-jwk' });
    var status = h('p', {});
    var remove = h('button', { class: 'fv-btn', type: 'button', text: 'Remove DAC' });
    var cancel = h('button', { class: 'fv-btn', type: 'button', text: 'Cancel' });
    var save = h('button', { class: 'fv-btn', type: 'button', text: 'Save' });
    var w = new Win({ title: 'Define DAC \u00B7 ' + label, w: 600, h: 440, center: true, escCloses: true,
      content: h('div', { class: 'fv-form' }, [
        h('p', { text: 'An object carrying both items below is governed by the delegated access control provider they name, in place of its own access control list. Leave both empty and Remove to return it to its list.' }),
        uri.row,
        h('div', { style: 'display:flex;flex-direction:column;gap:4px;flex:none' }, [certLabel, cert]),
        status,
        h('div', { class: 'fv-row end' }, [remove, h('span', { style: 'flex:1' }), cancel, save]) ]) });

    // Read what the object already has, so the dialog edits rather than blindly overwrites.
    (async function () {
      try {
        var got = await getLeaf(url + '?metadata=cdmi_dac_uri&metadata=cdmi_dac_certificate', { quiet: true });
        var md = (got.rep && got.rep.metadata) || {};
        if (md.cdmi_dac_uri) uri.input.value = md.cdmi_dac_uri;
        if (md.cdmi_dac_certificate != null) cert.value = typeof md.cdmi_dac_certificate === 'string' ? md.cdmi_dac_certificate : JSON.stringify(md.cdmi_dac_certificate, null, 2);
      } catch (e) { /* a fresh object has none; leave the fields empty */ }
    })();

    async function patch(body, done) {
      status.textContent = 'Saving \\u2026';
      try {
        var res = await send('PATCH', url, dir(url) ? T_CONTAINER : T_OBJECT, JSON.stringify(body));
        if (!res.ok) throw await toError(res);
        w.close(); if (done) done();
      } catch (e) { status.textContent = 'Not saved: ' + (e && e.message || e); }
    }
    function dir(u) { return /\/$/.test(stripQuery(u)); }

    save.addEventListener('click', function () {
      var u = uri.input.value.trim(), c = cert.value.trim();
      if (!u && !c) { status.textContent = 'Give a provider URI and certificate, or use Remove.'; return; }
      if (!/^https:\/\//i.test(u)) { status.textContent = 'The provider URI must be an https: URL.'; return; }
      if (!c) { status.textContent = 'A certificate (JWK) is required for the object to be governed.'; return; }
      var cval; try { cval = JSON.parse(c); } catch (e) { cval = c; }   // a JWK is JSON; pass a string through if it is not
      patch({ metadata: { cdmi_dac_uri: u, cdmi_dac_certificate: cval } });
    });
    remove.addEventListener('click', function () {
      // Clearing both items removes DAC governance. seedmi accepts an empty string / null to delete a metadata item.
      patch({ metadata: { cdmi_dac_uri: '', cdmi_dac_certificate: '' } }, function () { uri.input.value = ''; cert.value = ''; });
    });
    cancel.addEventListener('click', function () { w.close(); });
  }

  /* Retention and hold (spec 16). A retention period keeps an object from being deleted or modified until it passes;
     a hold keeps it so until the hold is released. Both are data-system metadata items: cdmi_retention_id (an
     identifier), cdmi_retention_period (an ISO 8601 time interval), cdmi_retention_autodelete ("true"/"false"), and
     cdmi_hold_id (an array of hold identifiers). A period may be extended and never shortened, and a hold is added
     through this interface but released only outside it -- so a Release here surfaces the server's refusal, which is
     the explanation. Offered where the server publishes cdmi_retention or cdmi_hold. */
  // Retention and hold are data-system capabilities of the OBJECT (cdmi_data_retention / cdmi_data_holds on its
  // capabilitiesURI), not server-wide, so support is read from the object's capability object -- cached by that URI,
  // since every object of a type shares one. The capabilitiesURI is a path relative to the binding root.
  var typeCapsCache = {};
  function objectCaps(url) {
    return getLeaf(url + '?capabilitiesURI', { quiet: true }).then(function (g) {
      var cu = g.rep && g.rep.capabilitiesURI; if (!cu) return {};
      var key = stripQuery(cu);
      if (key in typeCapsCache) return typeCapsCache[key];
      var capURL = /^https?:/i.test(cu) ? cu : objectIdBase(url) + cu.replace(/^\//, '');
      return getRep(capURL, T_CAPABILITY, { quiet: true }).then(
        function (cg) { return (typeCapsCache[key] = (cg.rep && cg.rep.capabilities) || {}); },
        function () { return (typeCapsCache[key] = {}); });
    }, function () { return {}; });
  }
  function retentionInCaps(caps) { return !!(caps && (caps.cdmi_data_retention === 'true' || caps.cdmi_data_holds === 'true')); }
  // The lock state an object's metadata implies: held (any hold id), or retained (a period still in force). The
  // applied instant (cdmi_retention_applied) anchors a bare duration; without it, a present period is treated as in
  // force for the badge, the server being authoritative on the exact end.
  function restrictionFromMeta(md) {
    md = md || {};
    function strs(a) { return Array.isArray(a) ? a.filter(function (x) { return typeof x === 'string'; }) : null; }
    var holds = strs(md.cdmi_hold_id) || strs(md.cdmi_hold_id_provided) || [];
    // The server reports the resolved interval (with explicit start and end) in cdmi_retention_period_provided; the
    // client item cdmi_retention_period may be a bare duration. Prefer the provided form for the end instant.
    var provided = typeof md.cdmi_retention_period_provided === 'string' ? md.cdmi_retention_period_provided : '';
    var period = typeof md.cdmi_retention_period === 'string' ? md.cdmi_retention_period : '';
    var any = provided || period;
    var retainedUntil = retentionEnd(provided || period, md.cdmi_retention_applied);
    var retained = any !== '' && (retainedUntil === null || retainedUntil > Date.now());
    return { holds: holds, period: period || provided, retainedUntil: retainedUntil, retained: retained, held: holds.length > 0,
      restricted: holds.length > 0 || retained, autodelete: String(md.cdmi_retention_autodelete) === 'true' };
  }
  // The instant an ISO 8601 interval ends, given the applied instant for a bare duration; null where it cannot be told.
  function retentionEnd(period, appliedText) {
    if (!period) return null;
    function dur(p) { var m = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?)?$/.exec(p); if (!m) return null; var n = function (x) { return x ? +x : 0; }; return n(m[1]) * 365 * 864e5 + n(m[2]) * 30 * 864e5 + n(m[3]) * 864e5 + n(m[4]) * 36e5 + n(m[5]) * 6e4 + Math.round(n(m[6]) * 1e3); }
    function inst(t) { return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(t) ? Date.parse(t) : NaN; }
    var cut = period.indexOf('/');
    if (cut < 0) { var d = dur(period); if (d === null) return null; var from = appliedText ? Date.parse(appliedText) : Date.now(); return (isNaN(from) ? Date.now() : from) + d; }
    var L = period.slice(0, cut), R = period.slice(cut + 1), s = inst(L);
    if (!isNaN(s)) { var e = inst(R); if (!isNaN(e)) return e; var d2 = dur(R); return d2 === null ? null : s + d2; }
    var d3 = dur(L), e2 = inst(R); return (d3 === null || isNaN(e2)) ? null : e2;
  }
  function lockSvg() { return '<svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="#fff" stroke-width="1.3"><rect x="2.5" y="5.2" width="7" height="5" rx="1" fill="#fff" stroke="none"/><path d="M4 5.2V3.6a2 2 0 0 1 4 0v1.6" stroke="#fff"/></svg>'; }

  async function defineRetentionWindow(url) {
    var d = diskFor(url), label = d ? d.name + ':' + pathIn(d, url) : url, n = ++uid;
    // Same shape as Define ACL/DAC: each labelled input is a .fv-row (bold sans label, standard mono input);
    // group headings are h6 with the enabling checkbox.
    var HEAD = 'margin:4px 0 0;font:700 12px var(--sans);border-bottom:1px solid var(--dk);padding-bottom:2px';
    function head(cb, title) { return h('h6', { style: HEAD }, [h('label', { style: 'display:flex;align-items:center;gap:6px;font:inherit;cursor:pointer' }, [cb, h('span', { text: title })])]); }
    function body(kids) { return h('div', { style: 'display:flex;flex-direction:column;gap:6px' }, kids); }

    var cbPeriod = h('input', { type: 'checkbox' });
    var periodF = field('fvrp' + n, 'Period', ''); periodF.input.placeholder = 'ISO 8601, e.g. P30D or P1Y6M';
    var startF = field('fvrs' + n, 'Start', ''); startF.input.placeholder = 'instant, e.g. 2026-01-01T00:00:00Z (blank = when applied)';
    var period = periodF.input, start = startF.input;
    var periodBody = body([periodF.row, startF.row]);
    var cbId = h('input', { type: 'checkbox' });
    var idF = field('fvri' + n, 'Identifier', ''); idF.input.placeholder = 'an identifier for this retention';
    var rid = idF.input;
    var idBody = idF.row;
    var cbAuto = h('input', { type: 'checkbox' }), adTrue = h('input', { type: 'radio', name: 'fvad' + n }), adFalse = h('input', { type: 'radio', name: 'fvad' + n });
    adFalse.checked = true;
    var autoBody = h('div', { class: 'checks', style: 'font:12px var(--sans)' }, [
      h('label', {}, [adTrue, h('span', { text: 'autodelete when the period passes (true)' })]),
      h('label', {}, [adFalse, h('span', { text: 'keep after the period (false)' })]) ]);
    var cbHolds = h('input', { type: 'checkbox' }), holdsCur = h('div', { style: 'font:12px var(--mono);color:#333' });
    var holdF = field('fvrh' + n, 'Add a hold', ''); holdF.input.placeholder = 'a hold identifier';
    var newHold = holdF.input;
    var holdsBody = body([ holdsCur, holdF.row,
      h('small', { text: 'A hold is added through the CDMI interface but released outside it (an administrative action), so there is no release here.' }) ]);

    var inForce = h('p', { style: 'font:12px var(--mono);color:#333' });
    var status = h('p', {});
    var close = h('button', { class: 'fv-btn', type: 'button', text: 'Close' });
    var save = h('button', { class: 'fv-btn', type: 'button', text: 'Apply checked' });
    var groups = [
      { cb: cbPeriod, inputs: [period, start] }, { cb: cbId, inputs: [rid] },
      { cb: cbAuto, inputs: [adTrue, adFalse] }, { cb: cbHolds, inputs: [newHold] } ];
    function sync() { groups.forEach(function (g) { var on = g.cb.checked && !g.cb.disabled; g.inputs.forEach(function (i) { i.disabled = !on; }); }); }
    groups.forEach(function (g) { g.cb.addEventListener('change', sync); });

    var w = new Win({ title: 'Define retention · ' + label, w: 600, h: 540, center: true, escCloses: true,
      content: h('div', { class: 'fv-form' }, [
        h('p', { text: 'A retention period keeps this object from deletion or modification until it passes; a hold keeps it so until released. Check an item to set it; unchecked items are left unchanged.' }),
        inForce,
        head(cbPeriod, 'Retention period'), periodBody,
        head(cbId, 'Retention identifier'), idBody,
        head(cbAuto, 'Autodelete'), autoBody,
        head(cbHolds, 'Legal holds'), holdsBody,
        status,
        h('div', { class: 'fv-row end' }, [close, h('span', { style: 'flex:1' }), save]) ]) });

    function showForce(md) {
      var r = restrictionFromMeta(md), bits = [];
      if (r.held) bits.push(r.holds.length + (r.holds.length === 1 ? ' hold' : ' holds'));
      if (r.retained) bits.push(r.retainedUntil ? 'retained until ' + new Date(r.retainedUntil).toISOString() : 'retained');
      inForce.textContent = bits.length ? 'In force: ' + bits.join(' · ') : 'Not currently under retention or hold.';
    }
    var curHolds = [];
    function drawHolds() { holdsCur.textContent = curHolds.length ? 'Current holds: ' + curHolds.join(', ') : 'No holds yet.'; }
    var METmeta = '?metadata=cdmi_retention_id&metadata=cdmi_retention_period&metadata=cdmi_retention_period_provided&metadata=cdmi_retention_autodelete&metadata=cdmi_hold_id&metadata=cdmi_hold_id_provided&metadata=cdmi_retention_applied';

    (async function () {
      try {
        var md = ((await getLeaf(url + METmetaFix(), { quiet: true })).rep || {}).metadata || {};
        if (typeof md.cdmi_retention_period === 'string') { period.value = md.cdmi_retention_period; cbPeriod.checked = true; }
        if (md.cdmi_retention_id) { rid.value = md.cdmi_retention_id; cbId.checked = true; }
        if (md.cdmi_retention_autodelete !== undefined) { (String(md.cdmi_retention_autodelete) === 'true' ? adTrue : adFalse).checked = true; cbAuto.checked = true; }
        curHolds = Array.isArray(md.cdmi_hold_id) ? md.cdmi_hold_id.slice() : (Array.isArray(md.cdmi_hold_id_provided) ? md.cdmi_hold_id_provided.slice() : []);
        drawHolds(); showForce(md);
      } catch (e) { drawHolds(); inForce.textContent = 'Could not read the current retention (' + (e && e.message || e) + ').'; }
      try {
        var caps = await objectCaps(url), canRetain = caps.cdmi_data_retention === 'true', canHold = caps.cdmi_data_holds === 'true';
        if (!canRetain && !canHold) { status.textContent = 'This object’s type advertises neither retention nor hold.'; save.disabled = true; groups.forEach(function (g) { g.cb.disabled = true; g.cb.checked = false; }); }
        else {
          if (!canRetain || caps.cdmi_retention_period !== 'true') { cbPeriod.disabled = true; cbPeriod.checked = false; }
          if (!canRetain || caps.cdmi_retention_id !== 'true') { cbId.disabled = true; cbId.checked = false; }
          if (!canRetain || caps.cdmi_retention_autodelete !== 'true') { cbAuto.disabled = true; cbAuto.checked = false; }
          if (!canHold) { cbHolds.disabled = true; cbHolds.checked = false; }
        }
      } catch (e) {}
      sync();
    })();

    save.addEventListener('click', async function () {
      var meta = {};
      if (cbPeriod.checked && !cbPeriod.disabled) { var p = period.value.trim(), s = start.value.trim(); if (!p) { status.textContent = 'Retention period is checked but no period is given.'; return; } meta.cdmi_retention_period = (s && p.indexOf('/') < 0) ? s + '/' + p : p; }
      if (cbId.checked && !cbId.disabled) meta.cdmi_retention_id = rid.value.trim();
      if (cbAuto.checked && !cbAuto.disabled) meta.cdmi_retention_autodelete = adTrue.checked ? 'true' : 'false';
      if (cbHolds.checked && !cbHolds.disabled) { var nh = newHold.value.trim(); if (nh) { if (curHolds.indexOf(nh) >= 0) { status.textContent = 'That hold is already applied.'; return; } meta.cdmi_hold_id = curHolds.concat([nh]); } }
      if (!Object.keys(meta).length) { status.textContent = 'Nothing checked to apply.'; return; }
      status.textContent = 'Saving …';
      try {
        var res = await send('PATCH', url, /\/$/.test(stripQuery(url)) ? T_CONTAINER : T_OBJECT, JSON.stringify({ metadata: meta }));
        if (!res.ok) throw await toError(res);
        var md2 = ((await getLeaf(url + METmetaFix(), { quiet: true })).rep || {}).metadata || {};
        curHolds = Array.isArray(md2.cdmi_hold_id) ? md2.cdmi_hold_id.slice() : (Array.isArray(md2.cdmi_hold_id_provided) ? md2.cdmi_hold_id_provided.slice() : []);
        drawHolds(); showForce(md2); newHold.value = ''; lockCache[stripQuery(url)] = restrictionFromMeta(md2);
        status.textContent = 'Applied.';
      } catch (e) { status.textContent = 'Refused: ' + (e && e.message || e); }
    });
    function METmetaFix() { return METmeta; }
    close.addEventListener('click', function () { w.close(); });
  }

  // A probe (cached) of an object's retention/hold, for the lock overlay and the move pre-check.
  var lockCache = {};
  function probeLock(url) {
    var key = stripQuery(url);
    if (key in lockCache) return Promise.resolve(lockCache[key]);
    return getLeaf(url + '?metadata=cdmi_hold_id&metadata=cdmi_hold_id_provided&metadata=cdmi_retention_period&metadata=cdmi_retention_period_provided&metadata=cdmi_retention_applied', { quiet: true })
      .then(function (g) { return (lockCache[key] = restrictionFromMeta((g.rep && g.rep.metadata) || {})); },
            function () { return (lockCache[key] = { restricted: false, holds: [], held: false, retained: false }); });
  }
  function lockBadgeFor(r) {
    if (!r || !r.restricted) return null;
    var tip = r.held && r.retained ? 'retained and under ' + r.holds.length + (r.holds.length === 1 ? ' hold' : ' holds')
      : r.held ? 'under ' + r.holds.length + (r.holds.length === 1 ? ' hold' : ' holds')
      : r.retainedUntil ? 'retained until ' + new Date(r.retainedUntil).toISOString() : 'retained';
    return { cls: r.held ? 'held' : '', tip: tip };
  }

  function capOn(name) { var v = CD.caps && CD.caps[name]; return v === 'true' || v === true; }

  /* Encryption (spec 20). This server encrypts an object's value in place as a JWE: an update that sets the mimetype
     to application/jose+json and supplies cdmi_enc_key_id (a key encryption key held at the domain's key management
     server) encrypts it; setting the mimetype back to the plaintext media type decrypts it; a different key id re-
     encrypts it. Gated on the object's cdmi_encryption capability and the server's cdmi_enc_inplace capability. The
     window follows the Define DAC shape: a couple of fields and the actions, reading the current state first. */
  function isEncryptedMime(m) { return /^application\/(jose(\+json)?|cms)/.test(m || ''); }
  async function defineEncryptionWindow(url) {
    var d = diskFor(url), label = d ? d.name + ':' + pathIn(d, url) : url, n = ++uid;
    var keyId = field('fvek' + n, 'Key encryption key', ''); keyId.input.placeholder = 'cdmi_enc_key_id — a key at the domain’s KMS';
    var ptype = field('fvep' + n, 'Plaintext media type', ''); ptype.input.placeholder = 'e.g. text/plain (used when decrypting)';
    var state = h('p', { style: 'font:12px var(--mono);color:#333' });
    var kmsHint = h('small', {});
    var status = h('p', {});
    var bEnc = h('button', { class: 'fv-btn', type: 'button', text: 'Encrypt' });
    var bDec = h('button', { class: 'fv-btn', type: 'button', text: 'Decrypt', style: 'display:none' });
    var close = h('button', { class: 'fv-btn', type: 'button', text: 'Close' });
    var w = new Win({ title: 'Define encryption · ' + label, w: 620, h: 440, center: true, escCloses: true,
      content: h('div', { class: 'fv-form' }, [
        h('p', { text: 'This server encrypts a value in place as a JWE. Encrypting sets the media type to application/jose+json and wraps the value under the named key encryption key; decrypting restores the plaintext media type; a different key re-encrypts.' }),
        state, keyId.row, ptype.row, kmsHint, status,
        h('div', { class: 'fv-row end' }, [bDec, h('span', { style: 'flex:1' }), close, bEnc]) ]) });

    function refreshParent() { var parent = parentOf(stripQuery(url).replace(/\/$/, '')); delete lockCache[stripQuery(url)]; browsers.forEach(function (b) { if (!b.win.closed && b.url === parent) b.show(b.url); }); }
    (async function () {
      var encrypted = false;
      try {
        var got = await getLeaf(url + '?mimetype&metadata=cdmi_enc_key_id&metadata=cdmi_encryption_provided', { quiet: true });
        var mime = got.rep.mimetype || '', md = got.rep.metadata || {};
        encrypted = isEncryptedMime(mime);
        if (md.cdmi_enc_key_id) keyId.input.value = md.cdmi_enc_key_id;
        var prov = md.cdmi_encryption_provided;
        state.textContent = encrypted ? 'Encrypted · ' + mime + (prov ? ' · ' + (typeof prov === 'string' ? prov : JSON.stringify(prov)) : '') : 'Not encrypted · ' + (mime || '(no media type)');
        bDec.style.display = encrypted ? '' : 'none';
        bEnc.textContent = encrypted ? 'Re-encrypt' : 'Encrypt';
        ptype.row.style.display = encrypted ? '' : 'none';
      } catch (e) { state.textContent = 'Could not read the object (' + (e && e.message || e) + ').'; }
      try {
        var caps = await objectCaps(url);
        if (caps.cdmi_encryption !== 'true' || !capOn('cdmi_enc_inplace')) {
          status.textContent = caps.cdmi_encryption !== 'true' ? 'This object’s type does not advertise cdmi_encryption.' : 'This server does not publish cdmi_enc_inplace (no key management server is configured).';
          bEnc.disabled = bDec.disabled = keyId.input.disabled = true;
        }
      } catch (e) { /* leave enabled; the server is authoritative */ }
      // The domain's configured key management servers, as a hint for the key id.
      try {
        var dg = await getLeaf(url + '?domainURI', { quiet: true }), du = dg.rep && dg.rep.domainURI;
        if (du) { var durl = /^https?:/i.test(du) ? du : objectIdBase(url) + du.replace(/^\//, ''); if (!/\/$/.test(durl)) durl += '/';
          var kg = await getRep(durl + '?metadata=cdmi_domain_kms', T_DOMAIN, { quiet: true });
          var kms = kg.rep && kg.rep.metadata && kg.rep.metadata.cdmi_domain_kms;
          if (kms) kmsHint.textContent = 'Key management servers for this domain: ' + (Array.isArray(kms) ? kms.map(function (k) { return k && (k.label || k.name) || JSON.stringify(k); }).join(', ') : typeof kms === 'string' ? kms : JSON.stringify(kms));
        }
      } catch (e) { /* no hint */ }
    })();
    async function apply(body, ok) {
      status.textContent = 'Saving …';
      try { var res = await send('PATCH', url, /\/$/.test(stripQuery(url)) ? T_CONTAINER : T_OBJECT, JSON.stringify(body)); if (!res.ok) throw await toError(res); status.textContent = 'Done.'; if (ok) ok(); }
      catch (e) { status.textContent = 'Refused: ' + (e && e.message || e); }
    }
    bEnc.addEventListener('click', function () { var k = keyId.input.value.trim(); if (!k) { status.textContent = 'Enter the key encryption key id.'; return; } apply({ mimetype: 'application/jose+json', metadata: { cdmi_enc_key_id: k } }, function () { refreshParent(); w.close(); }); });
    bDec.addEventListener('click', function () { var t = ptype.input.value.trim() || 'text/plain'; apply({ mimetype: t }, function () { refreshParent(); w.close(); }); });
    close.addEventListener('click', function () { w.close(); });
  }

  /* An object signature (spec 20) is a JWS compact serialization held in cdmi_enc_signature, over a canonical payload
     carrying the object's objectID, mimetype, value digest, and metadata. Verifying has two parts: the payload must
     describe the object as it stands (the value digest recomputed from the stored value must match), and the JWS
     signature must verify under the signing key's public key. The first is checked here from the object itself; the
     second needs the public key the KMS holds (cdmi_enc_object_verify_id), so its cryptographic step is reported as
     requiring that key where it is not directly readable. */
  function b64urlToBytes(s) { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; var bin = atob(s), a = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return a; }
  function hexUpper(buf) { var a = new Uint8Array(buf), s = ''; for (var i = 0; i < a.length; i++) s += a[i].toString(16).padStart(2, '0'); return s.toUpperCase(); }
  async function verifySignatureWindow(url) {
    var d = diskFor(url), label = d ? d.name + ':' + pathIn(d, url) : url, n = ++uid;
    var out = h('div', { style: 'font:12px var(--mono);white-space:pre-wrap;overflow-wrap:anywhere' });
    var close = h('button', { class: 'fv-btn', type: 'button', text: 'Close' });
    var w = new Win({ title: 'Verify signature · ' + label, w: 640, h: 460, center: true, escCloses: true,
      content: h('div', { class: 'fv-form' }, [ h('p', { text: 'An object signature (cdmi_enc_signature) is a JWS over a canonical payload that records the object’s value digest. This checks that the signed digest still matches the object’s content, and shows the signature’s header.' }), out, h('div', { class: 'fv-row end' }, [close]) ]) });
    close.addEventListener('click', function () { w.close(); });
    function line(s) { out.appendChild(h('div', { text: s })); }
    (async function () {
      try {
        var got = await getLeaf(url + '?objectID&mimetype&metadata=cdmi_enc_signature', { quiet: true });
        var sig = got.rep.metadata && got.rep.metadata.cdmi_enc_signature;
        if (!sig || typeof sig !== 'string') { line('This object carries no cdmi_enc_signature.'); return; }
        var parts = sig.split('.'); if (parts.length !== 3) { line('The signature is not a JWS compact serialization.'); return; }
        var header = {}; try { header = JSON.parse(bytesToText(b64urlToBytes(parts[0]))); } catch (e) {}
        var payload = {}; try { payload = JSON.parse(bytesToText(b64urlToBytes(parts[1]))); } catch (e) {}
        line('Algorithm: ' + (header.alg || '(none)') + (header.kid ? '   kid: ' + header.kid : ''));
        line('Signed objectID: ' + (payload.objectID || '(none)') + (got.rep.objectID ? (payload.objectID === got.rep.objectID ? '  ✓ matches' : '  ✗ differs from ' + got.rep.objectID) : ''));
        if (payload.mimetype) line('Signed mimetype: ' + payload.mimetype + (got.rep.mimetype === payload.mimetype ? '  ✓' : '  ✗ now ' + (got.rep.mimetype || '(none)')));
        // Recompute the value digest and compare to the one the payload records.
        if (payload.valuedigest && payload.valuedigestalgorithm) {
          var vv = await readValue(await readObject(url));
          var bytes = vv.bytes ? vv.bytes : new TextEncoder().encode(vv.text || '');
          var algo = String(payload.valuedigestalgorithm).toUpperCase();
          if (['SHA-256', 'SHA-384', 'SHA-512'].indexOf(algo) < 0) { line('Value digest: unknown algorithm ' + payload.valuedigestalgorithm); }
          else { var dig = hexUpper(await crypto.subtle.digest(algo, bytes)); line('Value digest (' + payload.valuedigestalgorithm + '): ' + (dig === String(payload.valuedigest).toUpperCase() ? '✓ matches — the content is unchanged since it was signed' : '✗ DOES NOT MATCH — the content has changed since it was signed')); }
        } else { line('The payload records no value digest.'); }
        line('');
        line('Cryptographic signature: the JWS must be verified under the signing key’s public key' + (header.kid ? ' (kid ' + header.kid + ')' : '') + ', held at the key management server via cdmi_enc_object_verify_id. The content check above is independent of that key and detects tampering on its own.');
      } catch (e) { line('Could not verify: ' + (e && e.message || e)); }
    })();
  }

  /* Signing initiation (spec 20). Naming a signing key in cdmi_enc_object_sign_id makes the server sign the object as
     a whole and store the JWS in cdmi_enc_signature; cdmi_enc_value_sign_id signs the value. A verify key id is stored
     alongside so a reader can check the signature. Independent checkbox groups, gated on the object's capabilities;
     applying an object signing key produces a signature that Verify signature can then check. */
  async function defineSigningWindow(url) {
    var d = diskFor(url), label = d ? d.name + ':' + pathIn(d, url) : url, n = ++uid;
    var LBL = 'font:12px var(--sans)', GRID = 'display:grid;grid-template-columns:170px minmax(0,1fr);gap:6px 8px;align-items:center;margin-top:6px';
    function inp(ph) { return h('input', { class: 'fv-in', type: 'text', spellcheck: 'false', autocomplete: 'off', placeholder: ph || '' }); }
    function lab(t) { return h('label', { style: LBL, text: t }); }
    function head(cb, title) { return h('h6', {}, [h('label', { style: 'display:flex;align-items:center;gap:6px;font:inherit' }, [cb, h('span', { text: title })])]); }
    var cbObj = h('input', { type: 'checkbox' }), objSign = inp('cdmi_enc_object_sign_id — a signing key at the KMS'), objVerify = inp('cdmi_enc_object_verify_id — the public verify key (optional)');
    var objBody = h('div', { style: GRID }, [lab('Signing key'), objSign, lab('Verify key'), objVerify]);
    var cbVal = h('input', { type: 'checkbox' }), valSign = inp('cdmi_enc_value_sign_id — a signing key at the KMS'), valVerify = inp('cdmi_enc_value_verify_id — the public verify key (optional)');
    var valBody = h('div', { style: GRID }, [lab('Signing key'), valSign, lab('Verify key'), valVerify]);
    var status = h('p', {}), close = h('button', { class: 'fv-btn', type: 'button', text: 'Close' }), save = h('button', { class: 'fv-btn', type: 'button', text: 'Apply checked' });
    var groups = [{ cb: cbObj, inputs: [objSign, objVerify] }, { cb: cbVal, inputs: [valSign, valVerify] }];
    function sync() { groups.forEach(function (g) { var on = g.cb.checked && !g.cb.disabled; g.inputs.forEach(function (i) { i.disabled = !on; }); }); }
    groups.forEach(function (g) { g.cb.addEventListener('change', sync); });
    var w = new Win({ title: 'Define signing · ' + label, w: 620, h: 460, center: true, escCloses: true,
      content: h('div', { class: 'fv-form' }, [
        h('p', { text: 'Naming a signing key makes the server sign the object and store the result in cdmi_enc_signature; a value signing key signs the value. Store a verify key so a reader can check it. Check an item to set it.' }),
        head(cbObj, 'Object signature'), objBody,
        head(cbVal, 'Value signature'), valBody,
        status,
        h('div', { class: 'fv-row end' }, [close, h('span', { style: 'flex:1' }), save]) ]) });
    (async function () {
      try {
        var md = ((await getLeaf(url + '?metadata=cdmi_enc_object_sign_id&metadata=cdmi_enc_object_verify_id&metadata=cdmi_enc_value_sign_id&metadata=cdmi_enc_value_verify_id', { quiet: true })).rep || {}).metadata || {};
        if (md.cdmi_enc_object_sign_id) { objSign.value = md.cdmi_enc_object_sign_id; cbObj.checked = true; }
        if (md.cdmi_enc_object_verify_id) { objVerify.value = md.cdmi_enc_object_verify_id; cbObj.checked = true; }
        if (md.cdmi_enc_value_sign_id) { valSign.value = md.cdmi_enc_value_sign_id; cbVal.checked = true; }
        if (md.cdmi_enc_value_verify_id) { valVerify.value = md.cdmi_enc_value_verify_id; cbVal.checked = true; }
      } catch (e) {}
      try {
        var caps = await objectCaps(url);
        if (caps.cdmi_enc_object_sign_id !== 'true') { cbObj.disabled = true; cbObj.checked = false; }
        if (caps.cdmi_enc_value_sign_id !== 'true') { cbVal.disabled = true; cbVal.checked = false; }
        if (cbObj.disabled && cbVal.disabled) { status.textContent = 'This object’s type advertises no signing keys.'; save.disabled = true; }
      } catch (e) {}
      sync();
    })();
    save.addEventListener('click', async function () {
      var meta = {};
      if (cbObj.checked && !cbObj.disabled) { if (objSign.value.trim()) meta.cdmi_enc_object_sign_id = objSign.value.trim(); if (objVerify.value.trim()) meta.cdmi_enc_object_verify_id = objVerify.value.trim(); }
      if (cbVal.checked && !cbVal.disabled) { if (valSign.value.trim()) meta.cdmi_enc_value_sign_id = valSign.value.trim(); if (valVerify.value.trim()) meta.cdmi_enc_value_verify_id = valVerify.value.trim(); }
      if (!Object.keys(meta).length) { status.textContent = 'Nothing checked to apply (name a signing key).'; return; }
      status.textContent = 'Signing …';
      try {
        var res = await send('PATCH', url, /\/$/.test(stripQuery(url)) ? T_CONTAINER : T_OBJECT, JSON.stringify({ metadata: meta }));
        if (!res.ok) throw await toError(res);
        status.textContent = 'Applied — the server signed the object; check it with Verify signature.';
      } catch (e) { status.textContent = 'Refused: ' + (e && e.message || e); }
    });
    close.addEventListener('click', function () { w.close(); });
  }

  /* Storage goals (data system metadata): the requirements the data is stored against. Each is a data-system metadata
     item with a matching _provided item the server sets to what it actually delivers. Driven by a field-table schema
     in the manner of the exports/imports editor (ENTRY_SCHEMAS): one row per goal, gated on the object's capability
     of the same name, showing the requested value beside the provided one. */
  var STORAGE_GOALS = [
    { n: 'cdmi_data_redundancy', label: 'Data redundancy', k: 'n', h: 'The number of complete copies of the data to maintain' },
    { n: 'cdmi_infrastructure_redundancy', label: 'Infra. redundancy', k: 'n', h: 'The number of independent infrastructures across which copies are kept' },
    { n: 'cdmi_data_dispersion', label: 'Data dispersion', k: 'n', h: 'The minimum distance, in km, between copies' },
    { n: 'cdmi_geographic_placement', label: 'Geographic placement', k: 'l', h: 'The regions or URIs within which the data may be placed, one to a line' },
    { n: 'cdmi_latency', label: 'Latency (ms)', k: 'n', h: 'The maximum time to first byte, in milliseconds' },
    { n: 'cdmi_throughput', label: 'Throughput (B/s)', k: 'n', h: 'The minimum sustained transfer rate, in bytes per second' },
    { n: 'cdmi_RPO', label: 'RPO (s)', k: 'n', h: 'The recovery point objective, in seconds' },
    { n: 'cdmi_RTO', label: 'RTO (s)', k: 'n', h: 'The recovery time objective, in seconds' },
    { n: 'cdmi_sanitization_method', label: 'Sanitization', k: 's', h: 'The method by which the data is erased when deleted' },
    { n: 'cdmi_value_hash', label: 'Value hash', k: 's', h: 'The hash algorithm the server computes over the value' },
    { n: 'cdmi_hash', label: 'Value hash digest', k: 's', ro: true, capAlt: 'cdmi_value_hash', h: 'The hash of the value the server computed (base16), present where a value hash algorithm is set' },
    { n: 'cdmi_lock', label: 'Lock', k: 's', h: 'The immutability lock to apply' },
    { n: 'cdmi_immediate_redundancy', label: 'Immediate redundancy', k: 'n', h: 'The number of copies to make before the write is acknowledged' },
    { n: 'cdmi_assignedsize', label: 'Assigned size', k: 'n', h: 'The size, in bytes, to assign to this object' }
  ];
  async function defineStorageGoalsWindow(url) {
    var d = diskFor(url), label = d ? d.name + ':' + pathIn(d, url) : url;
    var COLS = '160px 1fr 1fr';
    var rows = h('div', { style: 'display:grid;grid-template-columns:' + COLS + ';gap:6px 10px;align-items:start' });
    var status = h('p', {});
    var save = h('button', { class: 'fv-btn', type: 'button', text: 'Apply goals' });
    var close = h('button', { class: 'fv-btn', type: 'button', text: 'Close' });
    var w = new Win({ title: 'Storage goals · ' + label, w: 700, h: 580, center: true, escCloses: true,
      content: h('div', { class: 'fv-form' }, [
        h('p', { text: 'Storage goals express the requirements the data is stored against. The server reports what it actually provides beside each goal it offers; a goal the object’s type does not advertise is shown disabled.' }),
        h('div', { style: 'display:grid;grid-template-columns:' + COLS + ';gap:4px 10px' }, [h('b', { text: 'Goal' }), h('b', { text: 'Requested' }), h('b', { text: 'Provided' })]),
        rows, status,
        h('div', { class: 'fv-row end' }, [close, h('span', { style: 'flex:1' }), save]) ]) });
    var controls = {};
    function build(caps, md) {
      rows.textContent = ''; controls = {}; var anySupported = false;
      STORAGE_GOALS.forEach(function (f) {
        var supported = caps[f.n] === 'true' || (f.capAlt && caps[f.capAlt] === 'true');
        if (supported && !f.ro) anySupported = true;         // a read-only (server-computed) item does not enable Apply
        var reqVal = md[f.n], input;
        if (f.k === 'l') { input = h('textarea', { rows: '2', spellcheck: 'false', style: 'width:100%;box-sizing:border-box;font:12px var(--mono);background:#fff;border:2px solid;border-color:var(--dk) var(--lt) var(--lt) var(--dk);padding:3px 6px;resize:vertical' }); input.value = Array.isArray(reqVal) ? reqVal.join('\n') : ''; }
        else { input = h('input', { class: 'fv-in', type: 'text', spellcheck: 'false', autocomplete: 'off' }); input.value = (!f.ro && reqVal != null) ? String(reqVal) : ''; }
        input.disabled = !supported || f.ro;
        if (f.ro) input.placeholder = '(server-computed)';
        var provVal = f.ro ? reqVal : md[f.n + '_provided'];  // a read-only item is itself the provided value
        var provText = provVal != null ? (Array.isArray(provVal) ? provVal.join(', ') : String(provVal)) : (supported ? '—' : '(not offered)');
        rows.appendChild(h('label', { title: f.h, text: f.label, style: 'font:12px var(--sans);padding-top:5px' + (supported ? '' : ';color:#999') }));
        rows.appendChild(input);
        rows.appendChild(h('span', { style: 'font:12px var(--mono);color:#333;padding-top:5px;overflow-wrap:anywhere', text: provText }));
        controls[f.n] = { f: f, input: input, supported: supported };
      });
      save.disabled = !anySupported;
      if (!anySupported && !status.textContent) status.textContent = 'This object’s type advertises no storage goals.';
    }
    async function load() { var caps = await objectCaps(url); var g = await getLeaf(url + '?metadata', { quiet: true }); build(caps, (g.rep && g.rep.metadata) || {}); }
    (async function () { try { await load(); } catch (e) { status.textContent = 'Could not read goals: ' + (e && e.message || e); } })();
    save.addEventListener('click', async function () {
      var meta = {};
      STORAGE_GOALS.forEach(function (f) { var c = controls[f.n]; if (!c || !c.supported || f.ro) return;
        if (f.k === 'l') { var arr = c.input.value.split('\n').map(function (x) { return x.trim(); }).filter(Boolean); meta[f.n] = arr.length ? arr : null; }
        else { var v = c.input.value.trim(); meta[f.n] = v !== '' ? v : null; } });    // null clears an item
      status.textContent = 'Saving …';
      try { var res = await send('PATCH', url, /\/$/.test(stripQuery(url)) ? T_CONTAINER : T_OBJECT, JSON.stringify({ metadata: meta })); if (!res.ok) throw await toError(res); await load(); status.textContent = 'Applied. Provided values updated.'; }
      catch (e) { status.textContent = 'Refused: ' + (e && e.message || e); }
    });
    close.addEventListener('click', function () { w.close(); });
  }

  /* Serialization (spec 15): a container or object is serialized into a data object whose value is the canonical JSON
     form, by a create that carries a "serialize" field addressing the source; the reverse, "deserialize", re-creates
     the objects from such a form. The source is named by its absolute URI, exactly as a move or copy source is. The
     operation may be asynchronous: the created object reports completionStatus ("Processing"/"Complete"/"Error") and
     percentComplete, which a small progress window polls. */
  function progressWindow(title) {
    var bar = h('div', { style: 'height:14px;background:#7fb0d8;border-right:1px solid #4d7ea6;width:0%;transition:width .2s' });
    var barWrap = h('div', { style: 'background:#fff;border:2px solid;border-color:var(--dk) var(--lt) var(--lt) var(--dk);height:16px;overflow:hidden' }, [bar]);
    var msg = h('p', { text: 'Starting …' });
    var close = h('button', { class: 'fv-btn', type: 'button', text: 'Close', disabled: '' });
    var w = new Win({ title: title, w: 480, h: 200, center: true, escCloses: true, content: h('div', { class: 'fv-form' }, [msg, barWrap, h('div', { class: 'fv-row end' }, [close]) ]) });
    close.addEventListener('click', function () { w.close(); });
    return {
      set: function (status, pct) { msg.textContent = status; if (pct != null && isFinite(pct)) bar.style.width = Math.max(0, Math.min(100, +pct)) + '%'; },
      done: function (status) { msg.textContent = status || 'Complete.'; bar.style.width = '100%'; bar.style.background = '#2a7d3a'; close.disabled = false; },
      fail: function (status) { msg.textContent = status; bar.style.background = '#a01818'; close.disabled = false; }
    };
  }
  // A serialize/deserialize source is a namespace path relative to the binding root (a full URI is not accepted here,
  // unlike a move or copy source), so a URL on this server is reduced to that path the way the query app does.
  function nsPathOf(u) { var base = objectIdBase(u), s = stripQuery(u); return s.indexOf(base) === 0 ? '/' + s.slice(base.length) : s; }
  // Two URLs are on the same CDMI server when they share a binding root; serialize/deserialize resolve a source by
  // path only within one server, so a cross-server operation is bridged by the desktop rather than server to server.
  function sameServer(a, b) { return objectIdBase(a) === objectIdBase(b); }
  function refreshShowing(u) { var p = parentOf(stripQuery(u).replace(/\/$/, '')); browsers.forEach(function (b) { if (!b.win.closed && (b.url === p || b.url === u)) b.show(b.url); }); }
  async function pollCompletion(dest, prog) {
    var deadline = Date.now() + 120000, dtype = /\/$/.test(stripQuery(dest)) ? T_CONTAINER : T_OBJECT;
    for (;;) {
      var g;
      try { g = await getRep(dest + '?completionStatus&percentComplete', dtype, { quiet: true }); }
      catch (e) { prog.fail('Could not read progress: ' + (e && e.message || e)); return false; }
      var cs = g.rep.completionStatus, pc = g.rep.percentComplete;
      if (cs === 'Complete' || cs === undefined) { return true; }
      if (cs === 'Error') { prog.fail('The server reported an error completing the operation.'); return false; }
      prog.set('Processing …', pc != null ? +pc : null);
      if (Date.now() > deadline) { prog.fail('Timed out waiting for completion.'); return false; }
      await new Promise(function (r) { setTimeout(r, 500); });
    }
  }
  async function serializeContainer(url, label) {
    var dest = await pickObject({ mode: 'save', title: 'Serialize ' + label + ' to…' });
    if (!dest) return;
    var prog = progressWindow('Serialize · ' + label);
    if (sameServer(url, dest)) {
      // Same server: the destination server serializes the source directly by path.
      prog.set('Serializing to ' + dest + ' …', 0);
      try { var res = await send('PUT', dest, T_OBJECT, JSON.stringify({ serialize: nsPathOf(url) })); if (!res.ok) throw await toError(res); }
      catch (e) { prog.fail('Refused: ' + (e && e.message || e)); return; }
      if (await pollCompletion(dest, prog)) { prog.done('Serialized to ' + dest); refreshShowing(dest); }
      return;
    }
    // Cross-server: a server serializes only a source it holds, so the serialize runs on the source's own server into
    // a temporary object; the desktop reads that canonical form and writes it to the chosen destination, then removes
    // the temporary. The two servers never talk to each other.
    var tempURL = parentOf(stripQuery(url).replace(/\/$/, '')) + '.cvwm-serialize-' + (++uid);
    prog.set('Serializing on the source server …', 0);
    try { var r1 = await send('PUT', tempURL, T_OBJECT, JSON.stringify({ serialize: nsPathOf(url) })); if (!r1.ok) throw await toError(r1); }
    catch (e) { prog.fail('Refused on the source server: ' + (e && e.message || e)); return; }
    if (!(await pollCompletion(tempURL, prog))) { send('DELETE', tempURL).catch(function () {}); return; }
    prog.set('Transferring the serialized form to ' + dest + ' …', 50);
    try {
      var got = await readObject(tempURL), val = await readValue(got);
      var body = { mimetype: got.rep.mimetype || 'application/cdmi-container' };
      if (val.text !== undefined) { body.valuetransferencoding = 'utf-8'; body.value = val.text; }
      else { body.valuetransferencoding = 'base64'; body.value = bytesB64(val.bytes); }
      var r2 = await send('PUT', dest, T_OBJECT, JSON.stringify(body)); if (!r2.ok) throw await toError(r2);
    } catch (e) { prog.fail('Could not write to the destination: ' + (e && e.message || e)); send('DELETE', tempURL).catch(function () {}); return; }
    send('DELETE', tempURL).catch(function () {});
    prog.done('Serialized to ' + dest + ' (via the source server)');
    refreshShowing(dest);
  }
  async function deserializeHere(url, label) {
    var n = ++uid;
    var src = field('fvds' + n, 'Source', ''); src.input.placeholder = 'a serialized object: URL or path';
    var choose = h('button', { class: 'fv-btn sm', type: 'button', text: 'Choose…' });
    var name = field('fvdn' + n, 'Destination name', ''); name.input.placeholder = 'name for the deserialized object here';
    var status = h('p', {});
    var cancel = h('button', { class: 'fv-btn', type: 'button', text: 'Cancel' });
    var go = h('button', { class: 'fv-btn', type: 'button', text: 'Deserialize' });
    var w = new Win({ title: 'Deserialize here · ' + label, w: 620, h: 340, center: true, escCloses: true,
      content: h('div', { class: 'fv-form' }, [
        h('p', { text: 'Create objects from a serialized object, placed in this container. The source may be on this server or another mounted one; a source on another server is read by the desktop and passed to this one inline.' }),
        h('div', { class: 'fv-row', style: 'gap:6px' }, [src.input, choose]),
        name.row, status,
        h('div', { class: 'fv-row end' }, [cancel, h('span', { style: 'flex:1' }), go]) ]) });
    choose.addEventListener('click', async function () { var p = await pickObject({ title: 'Choose the serialized object' }); if (p) { src.input.value = p; if (!name.input.value) name.input.value = (decodeURIComponent(stripQuery(p).replace(/\/$/, '').split('/').pop() || '') || 'object') + '.restored'; } });
    cancel.addEventListener('click', function () { w.close(); });
    go.addEventListener('click', function () {
      var s = src.input.value.trim(), nm = name.input.value.trim();
      if (!s) { status.textContent = 'Choose or enter a source.'; return; }
      // A trailing "/" the user types is a hint that the destination is a container. Strip it before the name is
      // percent-encoded, so the "/" is never encoded into the name itself (the server rejects "dacite%2F").
      var userDir = /\/$/.test(nm); nm = nm.replace(/\/+$/, '');
      if (!nm) { status.textContent = 'Enter a destination name.'; return; }
      var srcURL = /^https?:/i.test(s) ? s : objectIdBase(url) + s.replace(/^\//, '');
      w.close();
      (async function () {
        var prog = progressWindow('Deserialize · ' + nm);
        // Whether the destination is a container is decided by the serialized canonical's own objectType -- NOT by the
        // source object's media type (a serialized object is a data object whose VALUE holds the canonical form, so its
        // media type says nothing about what it deserializes to). Read the source value once, parse its objectType, and
        // reuse the bytes for the cross-server path. The trailing-"/" hint is the fallback if the content can't be read.
        prog.set('Reading the serialized object …', 0);
        var isCont = userDir, bytes = null;
        try {
          var got = await readObject(srcURL), val = await readValue(got);
          bytes = val.bytes ? val.bytes : new TextEncoder().encode(val.text || '');
          var ot = (JSON.parse(new TextDecoder('utf-8').decode(bytes)) || {}).objectType || '';
          if (ot) isCont = /cdmi-(container|capability|domain)/.test(ot);
        } catch (e) { /* keep the user's trailing-"/" hint */ }
        var dest = url + enc(nm) + (isCont ? '/' : ''), destType = isCont ? T_CONTAINER : T_OBJECT;
        try {
          var body;
          if (sameServer(srcURL, url)) {
            // Same server: the destination server reads the serialized object by path (no need to send the bytes).
            prog.set('Deserializing ' + nsPathOf(srcURL) + ' …', 50);
            body = { deserialize: nsPathOf(srcURL) };
          } else {
            // Cross-server: hand the canonical form to the destination inline (deserializevalue), reusing the bytes
            // already read, so the destination needs no access to the source server.
            if (bytes === null) throw new Error('could not read the serialized object from its server');
            prog.set('Deserializing on this server …', 50);
            body = { deserializevalue: bytesB64(bytes) };
          }
          var res = await send('PUT', dest, destType, JSON.stringify(body)); if (!res.ok) throw await toError(res);
        }
        catch (e) { prog.fail('Refused: ' + (e && e.message || e)); return; }
        if (await pollCompletion(dest, prog)) { prog.done('Deserialized into ' + nm); browsers.forEach(function (b) { if (!b.win.closed && b.url === url) b.show(b.url); }); }
      })();
    });
  }

  /* Edit an object's access control list. The current cdmi_acl is read and shown in the shared ACL builder (the same
     one the create and DAC dialogs use), so entries can be added, removed and reordered, then written back. */
  async function defineAclWindow(url, kind) {
    var d = diskFor(url), label = d ? d.name + ':' + pathIn(d, url) : url, forDir = kind === 'container', n = ++uid;
    var type = forDir ? T_CONTAINER : kind === 'queue' ? T_QUEUE : T_OBJECT;
    // Domain, owner and access control list, in that order -- the same three shown when a container is created.
    var domain = field('fvadom' + n, 'Domain', ''); domain.input.placeholder = 'domainURI'; domain.input.disabled = true;
    var owner = field('fvaown' + n, 'Owner', ''); owner.input.placeholder = 'principal, e.g. alice@' + (CD.realm || 'REALM'); owner.input.disabled = true;
    var host = h('div', {}), status = h('p', { text: 'Reading the domain, owner and ACL …' });
    var cancel = h('button', { class: 'fv-btn', type: 'button', text: 'Cancel' });
    var save = h('button', { class: 'fv-btn', type: 'button', text: 'Save', disabled: '' });
    var w = new Win({ title: 'Define ACL · ' + label, w: 760, h: 640, center: true, escCloses: true,
      content: h('div', { class: 'fv-form' }, [
        h('p', { text: 'The domain names the set of principals and mappings the list is resolved against, and the owner holds OWNER@ in it. The list decides who may read, write and manage this object; entries are evaluated from the top, and a DENY overrides a later ALLOW.' }),
        domain.row,
        owner.row,
        h('h6', { text: 'Access control list' }),
        host, status,
        h('div', { class: 'fv-row end' }, [cancel, h('span', { style: 'flex:1' }), save]) ]) });
    var acl = null, origOwner = '', origDomain = '';
    (async function () {
      var initial = null, note = '';
      try {
        var got = await getLeaf(url + '?domainURI&metadata=cdmi_acl&metadata=cdmi_owner', { quiet: true });
        var rep = got.rep || {}, md = rep.metadata || {};
        if (Array.isArray(md.cdmi_acl)) initial = md.cdmi_acl; else note = 'This object has no ACL of its own yet; a default entry is shown.';
        origOwner = md.cdmi_owner || ''; origDomain = rep.domainURI || '';
      } catch (e) { note = 'Could not read the current domain, owner and ACL (' + (e && e.message || e) + '); starting from a default.'; }
      domain.input.value = origDomain; domain.input.disabled = false;
      owner.input.value = origOwner; owner.input.disabled = false;
      acl = aclBuilder(initial, { forDir: forDir });
      host.appendChild(acl.el); status.textContent = note; save.disabled = false;
    })();
    save.addEventListener('click', async function () {
      if (!acl) return;
      var meta = { cdmi_acl: acl.value() }, ov = owner.input.value.trim(), dv = domain.input.value.trim();
      if (ov && ov !== origOwner) meta.cdmi_owner = ov;    // change the owner only when a new one is given
      var body = { metadata: meta };
      if (dv && dv !== origDomain) body.domainURI = dv;    // change the domain only when a new one is given
      status.textContent = 'Saving …';
      try {
        var res = await send('PATCH', url, type, JSON.stringify(body));
        if (!res.ok) throw await toError(res);
        w.close();
      } catch (e) { status.textContent = 'Not saved: ' + (e && e.message || e); }
    });
    cancel.addEventListener('click', function () { w.close(); });
  }

  async function defineWindow(url, which, knownKind) {
    var isImports = which === 'imports', d = diskFor(url), label = d ? d.name + ':' + pathIn(d, url) : url;
    var dir = /\/$/.test(url), kind = knownKind, caps = {}, entries = [], selected = -1, busy = false;
    var types = ENTRY_SCHEMAS[which] || {}, common = ENTRY_SCHEMAS[isImports ? 'importCommon' : 'exportCommon'] || [], addressing = ENTRY_SCHEMAS.importAddress || [];
    var STATUS = {}; common.forEach(function (f) { if (f.srv) STATUS[f.n] = 1; });

    var stack = h('div', { class: 'fv-stack', role: 'listbox', 'aria-label': isImports ? 'Layers, uppermost first' : 'Export entries' });
    var form = h('div', { class: 'fv-entry' }), note = h('p', { text: 'Reading \u2026', role: 'status' }), jsonPreview = null;
    // Keep the "entry as JSON" preview in step with the field widgets: a field edit refreshes it in place (without
    // redrawing the whole form, which would steal focus). Set by drawForm, refreshed by each widget's set().
    function refreshJson(entry) { if (jsonPreview && jsonPreview._entry === entry && document.activeElement !== jsonPreview) jsonPreview.value = JSON.stringify(settable(entry), null, 2); }
    var bAdd = h('button', { class: 'fv-btn sm', type: 'button', text: isImports ? 'Add \u25BE' : 'Add export \u25BE', title: isImports ? 'Add a layer on top' : 'Add an export' }), bDel = h('button', { class: 'fv-btn sm', type: 'button', text: 'Remove' });
    var bUp = h('button', { class: 'fv-btn sm', type: 'button', text: 'Up', title: 'Move this layer above the one over it' }), bDown = h('button', { class: 'fv-btn sm', type: 'button', text: 'Down', title: 'Move this layer below the one under it' });
    var bApply = h('button', { class: 'fv-btn', type: 'button', text: 'Apply' }), bRevert = h('button', { class: 'fv-btn', type: 'button', text: 'Revert' }), bClose = h('button', { class: 'fv-btn', type: 'button', text: 'Close' });
    var w = new Win({ title: (isImports ? 'Imports' : 'Exports') + ' \u00B7 ' + label, icon: 'container', w: 820, h: 520, minW: 560, minH: 320, content: h('div', { class: 'fv-def' }, [
      h('div', { class: 'side' }, [h('h5', { text: isImports ? 'Layers \u2014 the uppermost first' : 'Export entries' }), stack, isImports ? h('div', { class: 'fv-ground', text: '\u25B2 upper layers hide names in the layers below \u25B2' }) : null,
        h('div', { class: 'tools' }, [bAdd, bDel, isImports ? bUp : null, isImports ? bDown : null])]),
      form, h('div', { class: 'foot' }, [note, bRevert, bApply, bClose])]) });
    function say(text, bad) { note.textContent = text; note.className = bad ? 'bad' : ''; }

    function schemaOf(type) { return types[type] || null; }
    function fieldsOf(entry) {                                     // what may be set on this entry, in the order it is shown
      var sc = schemaOf(entry.data.type), own = sc ? sc.f : [];
      return (isImports && entry.data.type !== 'self' ? addressing : []).concat(own.filter(function (f) { return !f.srv; }), common.filter(function (f) { return !f.srv && (!isImports || entry.data.type !== 'self' || f.n !== 'required'); }));
    }
    var OLDER_STATUS = [{ n: 'last_problem_time', srv: 1, h: 'The name an earlier draft gave to state_determined_time.' }];        // reported by servers of that draft; status all the same, and not to be sent back
    function statusOf(entry) { var sc = schemaOf(entry.data.type); return common.filter(function (f) { return f.srv; }).concat(sc ? sc.f.filter(function (f) { return f.srv; }) : [], OLDER_STATUS); }
    function settable(entry) {                                     // the entry as it is sent: without what the server populates
      var out = {}, drop = {}; statusOf(entry).forEach(function (f) { drop[f.n] = 1; });
      Object.keys(entry.data).forEach(function (k) { if (!drop[k]) out[k] = entry.data[k]; });
      return out;
    }
    // Whether this server offers a protocol here. Support is signalled by either the system-wide capability (the bare
    // "cdmi_export_<type>" / "cdmi_import_<type>", held on the server's ROOT capability object) or the per-object one
    // (with an object-type infix, e.g. "cdmi_export_container_http", held on this object's own capability object).
    // Some types (CDMI export, annex B) define only the system-wide form, so both places must be consulted.
    function offered(type) {
      var t = type.toLowerCase(), pre = 'cdmi_' + (isImports ? 'import' : 'export') + '_', root = CD.caps || {};
      if (type === 'self') return true;
      if (caps[pre + t] === 'true' || root[pre + t] === 'true') return true;
      return ['container', 'dataobject', 'queue'].some(function (o) { return caps[pre + o + '_' + t] === 'true' || root[pre + o + '_' + t] === 'true'; });
    }
    function versions(type) { var v = caps['cdmi_' + (isImports ? 'import' : 'export') + '_' + type.toLowerCase() + '_versions'] || (CD.caps || {})['cdmi_' + (isImports ? 'import' : 'export') + '_' + type.toLowerCase() + '_versions']; return Array.isArray(v) ? v : null; }
    // A capability that holds an array (the HTTP export origins and auth methods): on this object's capability object
    // where a server puts it there, else the server's root capabilities (CD.caps), where seedmi holds these two.
    function capList(name) { var v = caps[name]; if (!Array.isArray(v)) v = (CD.caps || {})[name]; return Array.isArray(v) ? v : null; }
    function capKnown(name) { return caps[name] !== undefined || (CD.caps || {})[name] !== undefined; }

    function lamp(entry) {
      var e = entry.data, problems = Array.isArray(e.last_problems) && e.last_problems.length;
      if (entry.fresh) return ['new', 'not yet applied'];
      if (e.type === 'self') return ['ok', 'the objects this container itself holds'];
      if (e.disabled === 'true') return ['', 'disabled'];
      if (e.active === 'true') return problems ? ['warn', 'active, with problems'] : ['ok', 'active'];
      return problems ? ['bad', 'not active'] : ['', 'not active'];
    }
    function drawStack() {
      stack.textContent = '';
      entries.forEach(function (entry, i) {
        var e = entry.data, state = lamp(entry), isSelf = e.type === 'self';
        var title = isImports ? (i + 1) + '. ' + (isSelf ? 'self' : e.type || '?') : (entry.name || '(unnamed)');
        var sub = isImports ? (isSelf ? 'what this container itself holds' : e.import_uri || '(no import_uri yet)') : (e.type || '?') + (e.path ? '  ' + e.path : e.sharename ? '  ' + e.sharename : e.bucket_name ? '  ' + e.bucket_name : e.topic ? '  ' + e.topic : '');
        var row = h('button', { class: 'fv-layer' + (i === selected ? ' sel' : '') + (isSelf ? ' self' : ''), type: 'button', role: 'option', 'aria-selected': String(i === selected), title: state[1] },
          [h('span', { class: 'fv-lamp ' + state[0] }), h('span', {}, [h('b', { text: title }), h('small', { text: sub })]), e.write_enabled === 'true' ? h('em', { text: 'WRITES', title: 'The write target: changes are directed to this layer' }) : null]);
        row.addEventListener('click', function () { select(i); });
        stack.appendChild(row);
      });
      if (!entries.length) stack.appendChild(h('div', { class: 'fv-ground', text: isImports ? 'No imports: the object presents what it holds itself.' : 'No exports are defined.' }));
      bDel.disabled = selected < 0; bUp.disabled = selected <= 0; bDown.disabled = selected < 0 || selected >= entries.length - 1;
    }
    function select(i) { selected = i; drawStack(); drawForm(); }

    function widget(entry, f) {
      var e = entry.data, id = 'fvd' + (++uid), value = e[f.n], el, row = h('div', { class: 'fv-f' });
      function set(v) { if (v === undefined || v === '' || (Array.isArray(v) && !v.length)) delete e[f.n]; else e[f.n] = v; entry.touched = true; drawStack(); refreshJson(entry); }
      // An export's "origins" field: a pick-list of the origins this server offers for that export type, from
      // cdmi_export_http_origins (HTTP) or cdmi_export_cdmi_origins (CDMI), both on the server's root capability object
      // (renamed and moved there in seedmi 0.101, per ECR-223A). Concrete origins are checkboxes; a wildcard value (e.g.
      // https://*.example.com:443) is shown as a pattern with a line to add a matching origin; an empty capability
      // array means the export is withheld.
      if (!isImports && (e.type === 'HTTP' || e.type === 'CDMI') && f.n === 'origins') {
        var originsCap = e.type === 'CDMI' ? 'cdmi_export_cdmi_origins' : 'cdmi_export_http_origins';
        var haveO = Array.isArray(value) ? value.slice() : [];
        el = h('div', { class: 'checks', id: id, role: 'group' }); el.dataset.field = f.n;
        if (!capKnown(originsCap)) {                 // capability not readable: fall back to free text
          var ta0 = h('textarea', { rows: '2', spellcheck: 'false', placeholder: 'one origin to a line, e.g. https://host:port' }); ta0.value = haveO.join('\n');
          ta0.addEventListener('input', function () { set(ta0.value.split('\n').map(function (x) { return x.trim(); }).filter(Boolean)); });
          el.appendChild(ta0);
        } else {
          var oList = capList(originsCap) || [];
          if (!oList.length) {
            el.appendChild(h('p', { class: 'bad', style: 'margin:0', text: 'This server offers no origin for a ' + e.type + ' export (' + originsCap + ' is empty), so one cannot be created here.' }));
          } else {
            var concrete = oList.filter(function (c) { return c.indexOf('*') < 0; }), patterns = oList.filter(function (c) { return c.indexOf('*') >= 0; });
            concrete.concat(haveO.filter(function (x) { return concrete.indexOf(x) < 0; })).forEach(function (o) {
              var box = h('input', { type: 'checkbox' }); box.checked = haveO.indexOf(o) >= 0;
              box.addEventListener('change', function () { haveO = haveO.filter(function (x) { return x !== o; }); if (box.checked) haveO.push(o); set(haveO.slice()); });
              el.appendChild(h('label', {}, [box, o]));
            });
            if (patterns.length) {
              el.appendChild(h('small', { style: 'display:block;color:var(--muted);margin-top:3px', text: 'Wildcard origins the server allows: ' + patterns.join(', ') + '. Add a matching origin:' }));
              var addIn = h('input', { class: 'fv-in', type: 'text', spellcheck: 'false', placeholder: 'https://host:port' });
              var addBtn = h('button', { class: 'fv-btn sm', type: 'button', text: 'Add' });
              var addO = function () { var v0 = addIn.value.trim(); if (v0 && haveO.indexOf(v0) < 0) { haveO.push(v0); set(haveO.slice()); drawForm(); } };
              addBtn.addEventListener('click', addO); addIn.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); addO(); } });
              el.appendChild(h('div', { class: 'fv-row', style: 'gap:6px;margin-top:4px' }, [addIn, addBtn]));
            }
          }
        }
        row.appendChild(h('label', { for: id, class: f.r ? 'req' : '', title: f.h, text: f.n })); row.appendChild(el); row.appendChild(h('small', { text: f.h }));
        return row;
      }
      // The protocol versions offered for a checkbox list come from the server's capability
      // (cdmi_export_nfs_versions / cdmi_import_nfs_versions, and likewise for other export types), which may be a
      // subset of the spec's set: the server states what it actually serves. The static schema list (f.o) is only the
      // fallback where the server advertises no such capability.
      var choices = (f.n === 'protocol' ? versions(e.type) : null) || f.o || null;
      // An HTTP export's "auth_method" is a single scheme, and the schemes to choose from are the set the server
      // advertises (cdmi_export_http_auth_methods) -- a subset of the spec's full list -- rather than the static list.
      if (!isImports && e.type === 'HTTP' && f.n === 'auth_method') { var am = capList('cdmi_export_http_auth_methods'); if (am) choices = am; }
      if (f.k === 'b' || f.k === 'e') {
        var opts = f.k === 'b' ? ['true', 'false'] : (choices || f.o).slice(); if (value !== undefined && opts.indexOf(value) < 0) opts.push(String(value));
        el = h('select', { id: id }, [h('option', { value: '', text: f.d !== undefined ? '(default: ' + f.d + ')' : '(not set)' })].concat(opts.map(function (o) { return h('option', { value: o, text: o }); })));
        el.value = value === undefined ? '' : String(value);
        el.addEventListener('change', function () {
          if (f.n === 'write_enabled' && el.value === 'true') entries.forEach(function (other) { if (other !== entry && other.data.write_enabled === 'true') { delete other.data.write_enabled; other.touched = true; } });   // one write target at most
          set(el.value);
        });
      } else if ((f.k === 'm' || f.k === 'l') && choices) {
        var have = Array.isArray(value) ? value.slice() : []; el = h('div', { class: 'checks', id: id, role: 'group' });
        choices.concat(have.filter(function (x) { return choices.indexOf(x) < 0; })).forEach(function (o) {
          var box = h('input', { type: 'checkbox' }); box.checked = have.indexOf(o) >= 0;
          box.addEventListener('change', function () { have = have.filter(function (x) { return x !== o; }); if (box.checked) have.push(o); set(choices.filter(function (x) { return have.indexOf(x) >= 0; }).concat(have.filter(function (x) { return choices.indexOf(x) < 0; }))); });
          el.appendChild(h('label', {}, [box, o]));
        });
      } else if (f.k === 'l') {
        el = h('textarea', { id: id, rows: '2', spellcheck: 'false', placeholder: 'one to a line' }); el.value = Array.isArray(value) ? value.join('\n') : '';
        el.addEventListener('input', function () { set(el.value.split('\n').map(function (x) { return x.trim(); }).filter(Boolean)); });
      } else if (f.k === 'j') {
        el = h('textarea', { id: id, rows: '3', spellcheck: 'false', placeholder: 'JSON' }); el.value = value === undefined ? '' : JSON.stringify(value, null, 2);
        el.addEventListener('input', function () { if (!el.value.trim()) { el.classList.remove('bad'); return set(undefined); } try { set(JSON.parse(el.value)); el.classList.remove('bad'); } catch (x) { el.classList.add('bad'); entry.invalid = f.n; return; } if (entry.invalid === f.n) entry.invalid = null; });
      } else {
        el = h('input', { class: 'fv-in', id: id, type: 'text', spellcheck: 'false', autocomplete: 'off', placeholder: f.n === 'import_uri' ? ((schemaOf(e.type) || {}).u || '') : (f.d !== undefined ? 'default: ' + f.d : '') }); el.value = value === undefined ? '' : String(value);
        el.addEventListener('input', function () { set(el.value.trim()); });
      }
      el.dataset.field = f.n;
      row.appendChild(h('label', { for: id, class: f.r ? 'req' : '', title: f.h, text: f.n })); row.appendChild(el); row.appendChild(h('small', { text: f.h + (f.c ? ' (Needed in some cases.)' : '') }));
      return row;
    }

    function drawForm() {
      form.textContent = ''; form.scrollTop = 0;
      var entry = entries[selected];
      if (!entry) { form.appendChild(h('p', { style: 'margin:6px 0', text: entries.length ? 'Choose an entry on the left.' : isImports
        ? 'Add a layer to bring another namespace, a block device, or a stream of messages into this object. Layers are searched from the top: a name held by an upper layer hides the same name below it.'
        : 'Add an export to present this object over another protocol.' })); return; }
      var e = entry.data, sc = schemaOf(e.type), known = {};
      if (!isImports) { var nid = 'fvd' + (++uid), nm = h('input', { class: 'fv-in', id: nid, type: 'text', spellcheck: 'false' }); nm.value = entry.name; nm.addEventListener('input', function () { entry.name = nm.value.trim(); entry.touched = true; drawStack(); });
        form.appendChild(h('div', { class: 'fv-f' }, [h('label', { for: nid, class: 'req', text: 'name' }), nm, h('small', { text: 'The name of this entry within the exports field. Renaming an entry removes it and adds another.' })])); }
      form.appendChild(h('div', { class: 'fv-f' }, [h('b', { text: 'type' }), h('output', { text: e.type + (sc ? (offered(e.type) ? '' : '   \u2014 this server does not list it among the capabilities of this object') : '   \u2014 not a type this desktop has a form for; edit it as JSON below') })]));
      if (isImports && e.type === 'self') form.appendChild(h('p', { style: 'margin:0', text: 'This layer is what the container itself holds. Without it those objects are not presented (they are kept, and return when it does). Move it to set what hides what.' }));
      fieldsOf(entry).forEach(function (f) { known[f.n] = 1; form.appendChild(widget(entry, f)); });
      var st = statusOf(entry).filter(function (f) { return e[f.n] !== undefined; });
      if (st.length) { form.appendChild(h('h6', { text: 'Status, as the server reports it' })); st.forEach(function (f) { known[f.n] = 1;
        var v = e[f.n], text = f.n === 'last_problems' && Array.isArray(v) ? (v.length ? v.map(function (p) { return (p.title || p.type || 'problem') + (p.detail ? ': ' + p.detail : ''); }).join('\n') : 'none') : typeof v === 'string' ? v : JSON.stringify(v);
        form.appendChild(h('div', { class: 'fv-f' }, [h('b', { text: f.n, title: f.h }), h('output', { style: 'white-space:pre-wrap', text: text })])); }); }
      form.appendChild(h('h6', { text: 'The entry as JSON' }));
      var raw = h('textarea', { rows: '7', spellcheck: 'false', 'aria-label': 'The entry as JSON', style: 'width:100%;font:12px var(--mono);min-height:90px' }); raw.value = JSON.stringify(settable(entry), null, 2); raw._entry = entry; jsonPreview = raw;
      raw.addEventListener('change', function () { try { var v = JSON.parse(raw.value); if (!v || typeof v !== 'object' || Array.isArray(v)) throw 0; if (v.type !== e.type) throw new Error('the type of an entry is not changed; remove it and add another'); statusOf(entry).forEach(function (f) { if (e[f.n] !== undefined) v[f.n] = e[f.n]; }); entry.data = v; entry.touched = true; entry.invalid = null; drawStack(); drawForm(); } catch (x) { raw.classList.add('bad'); say('That is not a JSON object' + (x && x.message ? ': ' + x.message : '') + '.', true); } });
      form.appendChild(h('div', { class: 'fv-f', style: 'grid-template-columns:minmax(0,1fr)' }, [raw]));
    }

    function adopt(value) {
      entries = [];
      if (isImports) (Array.isArray(value) ? value : []).forEach(function (e) { if (e && typeof e === 'object') entries.push({ data: JSON.parse(JSON.stringify(e)) }); });
      else Object.keys(value && typeof value === 'object' ? value : {}).forEach(function (name) { entries.push({ name: name, data: JSON.parse(JSON.stringify(value[name])) }); });
      select(entries.length ? Math.min(Math.max(selected, 0), entries.length - 1) : -1);
    }
    async function read() {
      var got = dir ? await getRep(url + '?objectType&capabilitiesURI&' + which, ACCEPT_DIR) : await getLeaf(url + '?objectType&capabilitiesURI&' + which);
      kind = got.rep.objectType === T_QUEUE ? 'queue' : got.rep.objectType === T_CONTAINER || dir ? 'container' : 'object';
      if (got.rep.capabilitiesURI && d) { try { caps = (await getRep(d.base + String(got.rep.capabilitiesURI).replace(/^\//, ''), T_CAPABILITY, { quiet: true })).rep.capabilities || {}; } catch (e) { caps = {}; } }
      adopt(got.rep[which]);
      say(entries.length ? '' : isImports ? 'This object has no imports field.' : 'This object has no exports.');
    }

    bAdd.addEventListener('click', function () {
      var r = bAdd.getBoundingClientRect(), mine = Object.keys(types).filter(function (t) { return types[t].on.indexOf(kind) >= 0; }), hasSelf = entries.some(function (x) { return x.data.type === 'self'; });
      popupMenu(r.left, r.bottom, isImports ? 'Add a layer on top' : 'Add an export', mine.filter(function (t) { return t !== 'self' || !hasSelf; }).sort(function (a, b) { return (offered(b) ? 1 : 0) - (offered(a) ? 1 : 0); }).map(function (t) {
        return { label: t + (offered(t) ? '' : '   (not offered here)'), action: function () {
          var entry = { data: { type: t }, fresh: true, touched: true }, base = t.toLowerCase(), n = 1;
          if (!isImports) { while (entries.some(function (x) { return x.name === base + (n > 1 ? n : ''); })) n++; entry.name = base + (n > 1 ? n : ''); entries.push(entry); selected = entries.length - 1; }
          else {
            if (t !== 'self' && kind === 'container' && !hasSelf && !entries.length) entries.push({ data: { type: 'self' }, fresh: true, touched: true });    // keep what the container holds in view, beneath the new layer
            entries.unshift(entry); selected = 0;
          }
          select(selected);
        } };
      }));
    });
    bDel.addEventListener('click', function () { if (selected < 0) return; entries.splice(selected, 1); entries.removed = true; select(Math.min(selected, entries.length - 1)); });
    function move(by) { var j = selected + by; if (selected < 0 || j < 0 || j >= entries.length) return; var x = entries[selected]; entries[selected] = entries[j]; entries[j] = x; x.touched = true; select(j); }
    bUp.addEventListener('click', function () { move(-1); }); bDown.addEventListener('click', function () { move(1); });
    bRevert.addEventListener('click', function () { read().catch(function (e) { say(e.message, true); }); });
    bClose.addEventListener('click', function () { w.close(); });

    bApply.addEventListener('click', async function () {
      if (busy) return;
      for (var i = 0; i < entries.length; i++) {                // what can be told without asking the server
        var entry = entries[i], missing = fieldsOf(entry).filter(function (f) { return f.r && (entry.data[f.n] === undefined || entry.data[f.n] === ''); })[0];
        if (entry.invalid) { select(i); return say(entry.invalid + ' is not valid JSON.', true); }
        if (!isImports && !entry.name) { select(i); return say('Every export entry needs a name.', true); }
        if (!isImports && entries.some(function (o) { return o !== entry && o.name === entry.name; })) { select(i); return say('Two entries are named ' + entry.name + '.', true); }
        if (missing) { select(i); var el = form.querySelector('[data-field="' + missing.n + '"]'); if (el) { el.classList.add('bad'); el.focus(); } return say(missing.n + ' is needed for an entry of type ' + entry.data.type + '.', true); }
      }
      if (isImports && kind === 'container' && entries.length && !entries.some(function (x) { return x.data.type === 'self'; }) &&
        !(await confirmBox('No "self" layer', 'Without a layer of type "self", the objects this container itself holds are not presented while these imports stand. They are kept, and return when a "self" layer does. Apply anyway?', 'Apply', 'Cancel'))) return;
      busy = true; say('Applying \u2026');
      try {
        var type = kind === 'container' ? T_CONTAINER : kind === 'queue' ? T_QUEUE : T_OBJECT, body = {}, res;
        if (!entries.length) { body[which] = null; res = await send('PATCH', url, type, JSON.stringify(body)); }       // removing the field, not leaving it empty: an empty imports array presents nothing at all
        else {
          if (isImports) body.imports = entries.map(settable); else { body.exports = {}; entries.forEach(function (x) { body.exports[x.name] = settable(x); }); }
          res = await send('PUT', url + '?' + which, type, JSON.stringify(body));                                        // the field alone, replaced whole: for imports the order is the meaning
        }
        if (!res.ok) {
          var why = null; try { why = await res.clone().json(); } catch (x) { /* no problem details */ }
          var ptr = why && typeof why.cdmi_field === 'string' ? why.cdmi_field.split('/').filter(Boolean) : [];       // e.g. /exports/site/origins, /imports/0/import_uri
          if (ptr[0] === which && ptr[1] !== undefined) { var at = isImports ? +ptr[1] : entries.map(function (x) { return x.name; }).indexOf(ptr[1]); if (at >= 0 && at < entries.length) { select(at); var bad = ptr[2] && form.querySelector('[data-field="' + ptr[2] + '"]'); if (bad) { bad.classList.add('bad'); if (bad.focus) bad.focus(); } } }
          throw await toError(res);
        }
        await read(); say('Applied. ' + (entries.length ? 'The status shown is what the server reports now.' : ''));
      } catch (e) { say(e.message, true); }
      busy = false;
    });

    drawStack(); drawForm();
    try { await read(); } catch (e) { say('Could not read ' + label + ': ' + e.message, true); }
    return w;
  }


  /* ------------------------------------------------------------------ versions of a data object

     A version-enabled data object names, in its metadata, its current version and its oldest (cdmi_version_current,
     cdmi_version_oldest); each version names the versions made from it (cdmi_version_children) and the one it was made
     from. Every one is a data object reached by its object ID, and immutable. Two updates that overlapped leave a
     version with two children, so the history is a tree and is drawn as one: a run of versions each made from the
     last stays in one column, and only a second child steps to the right.

     A historical version is opened in the plain viewer, never the editor. Reverting is an update of the data object
     that carries a "copy" field addressing the version; the state it had becomes the new current version, and nothing
     is lost, the version reverted from staying in the history. */
  async function enableVersioning(url, label) {
    if (!(await confirmBox('Enable versioning', 'Keep the earlier states of ' + label + '? From now on each change to its value leaves the state before it as a version that can be opened or reverted to.', 'Enable', 'Cancel'))) return;
    try { var res = await send('PATCH', url, T_OBJECT, JSON.stringify({ metadata: { cdmi_versioning: 'value' } })); if (!res.ok) throw await toError(res); versionsWindow(url); }
    catch (e) { messageBox('Cannot enable versioning', e.message); }
  }

  async function versionsWindow(url) {
    var d = diskFor(url), label = d ? d.name + ':' + pathIn(d, url) : url, base = objectIdBase(url), name = safeDecode(url.split('/').pop());
    var nodes = {}, roots = [], current = null, selected = null, LIMIT = 300;
    var tree = h('div', { class: 'fv-tree', role: 'tree', tabindex: '0', 'aria-label': 'Versions of ' + name }), note = h('p', { text: 'Reading \u2026', role: 'status' });
    var bOpen = h('button', { class: 'fv-btn', type: 'button', text: 'Open' }), bRevert = h('button', { class: 'fv-btn', type: 'button', text: 'Revert to this', title: 'Make the state this version holds the current state of the data object' });
    var bInfo = h('button', { class: 'fv-btn', type: 'button', text: 'Get info' }), bReload = h('button', { class: 'fv-btn', type: 'button', text: 'Reload' });
    var w = new Win({ title: 'Versions \u00B7 ' + label, icon: 'object', w: 640, h: 420, minW: 420, minH: 240, content: h('div', { class: 'fv-vers' }, [tree, h('div', { class: 'foot' }, [note, bReload, bInfo, bOpen, bRevert])]) });
    function say(text, bad) { note.textContent = text; note.className = bad ? 'bad' : ''; }
    function at(id) { return base + 'cdmi_objectid/' + enc(id); }

    async function load() {
      nodes = {}; roots = []; selected = null; say('Reading \u2026');
      var md = (await getLeaf(url + '?objectID&metadata')).rep.metadata || {};
      current = md.cdmi_version_current || null; roots = (md.cdmi_version_oldest || []).slice();
      var queue = roots.slice(), count = 0;
      while (queue.length && count < LIMIT) {                     // each version is read for its time, its size and the versions made from it
        var id = queue.shift(); if (nodes[id]) continue;
        try { var m = (await getRep(at(id) + '?objectID&mimetype&metadata', T_OBJECT)).rep; } catch (e) { nodes[id] = { id: id, gone: e.message, kids: [] }; continue; }
        var vm = m.metadata || {}; nodes[id] = { id: id, when: vm.cdmi_mtime || vm.cdmi_ctime || null, size: vm.cdmi_size, mime: m.mimetype, parent: vm.cdmi_version_parent || null, kids: (vm.cdmi_version_children || []).slice() };
        nodes[id].kids.forEach(function (k) { queue.push(k); }); count++;
      }
      draw(); say(count + (count === 1 ? ' version' : ' versions') + (queue.length ? ' shown; there are more' : '') + (md.cdmi_versioning ? ' \u00B7 cdmi_versioning: ' + md.cdmi_versioning : ' \u00B7 versioning is no longer enabled; these are kept'));
    }

    function draw() {
      tree.textContent = ''; var n = 0, lineage = {};
      for (var up = current; up && nodes[up] && !lineage[up]; up = nodes[up].parent) lineage[up] = true;          // the current version and everything it descends from
      function row(id, depth, rails, conn) {
        var v = nodes[id]; if (!v) return;
        var isCurrent = id === current, guide = rails.map(function () { return '\u2502  '; }).join('') + conn, inner = conn ? rails.concat([true]) : rails;     // rows beneath a side branch keep clear of its rail
        var el = h('div', { class: 'fv-ver' + (isCurrent ? ' cur' : '') + (id === selected ? ' sel' : ''), role: 'treeitem', tabindex: '-1', 'aria-level': String(depth + 1), 'aria-selected': String(id === selected), title: id }, [
          h('span', { class: 'guide', 'aria-hidden': 'true', text: guide }), h('span', { class: 'dot' + (isCurrent ? ' on' : '') }), h('span', { class: 'when', text: v.gone ? '(cannot be read: ' + v.gone + ')' : whenLabel(v.when).replace('\u2014', 'undated') + (v.when ? ':' + String(new Date(v.when).getSeconds()).padStart(2, '0') : '') }),
          h('span', { class: 'size', text: v.gone ? '' : sizeLabel(v.size === undefined ? null : +v.size) }), h('span', { class: 'id', text: id.replace(/^urn:uuid:/, '').slice(0, 13) + '\u2026' }), isCurrent ? h('em', { text: 'CURRENT' }) : v.kids.length > 1 ? h('em', { class: 'fork', text: v.kids.length + ' made from this' }) : null]);
        el.addEventListener('click', function () { selected = id; draw(); }); el.addEventListener('dblclick', function () { selected = id; open(); });
        tree.appendChild(el); n++;
        /* One child carries straight on beneath its parent. With more, the one that leads to the current version carries
           on (or the last made, off that line), and the others step to the right. */
        var kids = v.kids.filter(function (k) { return nodes[k]; }), main = kids.filter(function (k) { return lineage[k]; })[0] || kids[kids.length - 1];
        kids.filter(function (k) { return k !== main; }).forEach(function (k) { row(k, depth + 1, inner, '\u251C\u2500 '); });
        if (main) row(main, depth, inner, '');
      }
      roots.forEach(function (r, i) { if (i) tree.appendChild(h('div', { class: 'fv-ver gap', text: '\u2014 another line of versions \u2014' })); row(r, 0, [], ''); });
      if (!n) tree.appendChild(h('div', { class: 'fv-ver gap', text: 'No versions are recorded for this object.' }));
      var v = nodes[selected]; bOpen.disabled = bInfo.disabled = !v || !!v.gone; bRevert.disabled = !v || !!v.gone || selected === current;
    }

    function stampOf(v) { return v && v.when ? whenLabel(v.when) : 'an undated version'; }
    function open() { var v = nodes[selected]; if (!v || v.gone) return; openObject(at(selected), name, null, false, true, name + ' \u00B7 ' + (selected === current ? 'current version' : 'version of ' + stampOf(v)) + ' (read only)'); }
    bOpen.addEventListener('click', open);
    bInfo.addEventListener('click', function () { if (nodes[selected]) infoWindow(at(selected)); });
    bReload.addEventListener('click', function () { load().catch(function (e) { say(e.message, true); }); });
    tree.addEventListener('keydown', function (ev) {
      var ids = Array.prototype.map.call(tree.querySelectorAll('.fv-ver[title]'), function (e) { return e.title; }), i = ids.indexOf(selected);
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') { ev.preventDefault(); selected = ids[clamp(i + (ev.key === 'ArrowDown' ? 1 : -1), 0, ids.length - 1)]; draw(); var el = tree.querySelector('.sel'); if (el) el.scrollIntoView({ block: 'nearest' }); }
      else if (ev.key === 'Enter') { ev.preventDefault(); open(); }
    });
    bRevert.addEventListener('click', async function () {
      var v = nodes[selected]; if (!v || selected === current) return;
      if (!(await confirmBox('Revert', 'Make ' + name + ' what it was at ' + stampOf(v) + '? Its present state stays in the history, so this can be undone the same way.', 'Revert', 'Cancel'))) return;
      say('Reverting \u2026');
      try {
        var res = await send('PUT', url, T_OBJECT, JSON.stringify({ copy: '/cdmi_objectid/' + selected }));        // an update of the object, its new state copied from the version
        if (!res.ok) throw await toError(res);
        browsers.forEach(function (b) { if (!b.win.closed && b.url === parentOf(url)) b.show(b.url); });
        await load(); say('Reverted. ' + note.textContent);
      } catch (e) { say('Not reverted: ' + e.message, true); }
    });

    draw();
    try { await load(); } catch (e) { say('Could not read ' + label + ': ' + e.message, true); }
    return w;
  }

  /* ------------------------------------------------------------------ disks */

  var disks = [];           // {name, base, locked, manual}

  // Manual mounts persist across sessions. A cross-origin base is kept too (Option B); the credential still only
  // travels to an origin that has passed a CORS preflight (vouchCrossOrigin, req/send), so a stored cross-origin
  // disk that is not reachable simply reads anonymously or shows locked.
  function loadManual() { try { return JSON.parse(localStorage.getItem(MOUNTS_KEY) || '[]').filter(function (m) { return m && m.base && isTLS(m.base); }); } catch (e) { return []; } }
  function saveManual() { try { localStorage.setItem(MOUNTS_KEY, JSON.stringify(disks.filter(function (d) { return d.manual; }).map(function (d) { return { name: d.name, base: d.base }; }))); } catch (e) { /* storage unavailable */ } }
  function addMount(m) { if (!disks.some(function (d) { return d.base === m.base; })) { disks.push(m); saveManual(); drawDisks(); } }
  function homeDisk() { for (var i = 0; i < disks.length; i++) if (disks[i].home) return disks[i]; return null; }

  /* The signed-in principal's home (HOMES.md; spec 302, ECR-226A). Any object reports its domain in domainURI; the
     domain object carries a cdmi_domain_userinfo metadata item describing the requesting principal, with home_base
     and home_path naming the home. A home already found as a "home?" reference by discover() is left as it is. */
  var CD_home = null;               // { base, path } once known, so a re-scan can drop it on sign-out
  var vouchedOrigins = {};          // origins of homes the discovery vouched for, to which the credential may go (spec 302 s6)
  async function mountHome(found) {
    disks.forEach(function (d, i) { if (d.fromUserinfo) disks[i] = null; }); disks = disks.filter(Boolean);   // drop a home mounted last time
    CD_home = null;
    if (!CD.auth) { vouchedOrigins = {}; CD.userinfo = null; return; }        // anonymous has no home
    if (disks.some(function (d) { return d.home; })) return;                // discover() already found a "home?" reference
    // Discovered namespaces are no longer mounted (only home is), so probe through one of them, then a manual mount.
    var probe = disks[0] || (found && found[0]) || (loadManual()[0] && { base: loadManual()[0].base });
    if (!probe) return;
    var got;
    try { got = await getRep(probe.base + '?domainURI', T_CONTAINER, { quiet: true }); }
    catch (e) { return; }
    var domainURI = got.rep.domainURI; if (!domainURI) return;
    // domainURI is a namespace path relative to the base URI (a leading "/" is the base's root), or an absolute URI.
    var url = domainURI.indexOf('http') === 0 ? domainURI : probe.base + domainURI.replace(/^\//, '');
    if (!/\/$/.test(url)) url += '/';
    // cdmi_domain_userinfo is a metadata item of the domain object (ECR-226A): read the domain and take the item.
    var dom;
    try { dom = (await getRep(url + '?metadata=cdmi_domain_userinfo', T_DOMAIN, { quiet: true })).rep; }
    catch (e) { return; }
    var value = dom && dom.metadata && dom.metadata.cdmi_domain_userinfo;
    if (typeof value === 'string') { try { value = JSON.parse(value); } catch (e) { return; } }
    if (!value || !value.home_base || !value.home_path) return;
    CD.userinfo = value;                                                    // identifier, groups, privileges, realm — for ACL entries and display
    var base = value.home_base, path = String(value.home_path).replace(/^\//, '');
    if (!isTLS(base)) { console.warn('[cdmi] home: base URI is not https: ' + base); return; }
    var homeBase = base + path;
    if (!sameOrigin(base) && !(await vouchedOrigin(base))) { console.warn('[cdmi] home: at another origin without a CORS grant, not mounted: ' + base); return; }
    disks.push({ name: 'home', base: homeBase, home: true, fromUserinfo: true, crossOrigin: !sameOrigin(base) });
    CD_home = { base: base, path: path };
    try { await provisionHomeApps(homeBase, base); } catch (e) { console.warn('[cdmi] home apps: ' + (e && e.message || e)); }
  }

  /* A freshly created home has no applications of its own. Give it an "apps" container that layers the server's
     apps beneath the home's own: the uppermost "self" layer is the write target (anything the user drops in
     ~/apps/ is theirs and hides an imported app of the same name), and beneath it a read-only CDMI import brings
     in the server's apps container. The imports are set in the same create request -- a container carries its
     imports field when it is created, so there is no second write to leave the container importless if it fails.
     The import source is given as a namespace path ("/apps/"), not an absolute URI: a CDMI server treats a leading-
     "/" import_uri as a namespace of its own, so the import is unambiguously local (a delegated read of the server's
     apps), whereas an absolute URI is only local when it matches one of the server's configured base URIs exactly --
     and where it does not, the server reads it as a remote import and refuses it (no token endpoint), which fails the
     whole create. Done once, on first sight of a home that has no apps container yet; a home that already has one is
     left untouched. Best-effort: a failure here never stops the desktop from coming up. */
  async function provisionHomeApps(homeBase, serverBase) {
    var appsURL = homeBase + CFG.appsDir;                                   // e.g. <home>/apps/
    var probe;
    try { probe = await req(appsURL + '?objectType', T_CONTAINER, { quiet: true, probe: true }); }
    catch (e) { return; }                                                   // cannot tell; leave it alone
    if (probe.ok) return;                                                   // the home already has an apps container
    if (probe.status !== 404) return;                                       // 401/403/etc: not ours to create
    var imports = [
      { type: 'self', write_enabled: 'true' },                             // the home's own apps, on top and writable
      { type: 'CDMI', import_uri: '/' + CFG.appsDir, write_enabled: 'false' }   // the server's apps (namespace path), read-only, beneath
    ];
    var im = await send('PUT', appsURL, T_CONTAINER, JSON.stringify({ metadata: {}, imports: imports }));
    if (!im.ok) console.warn('[cdmi] home apps: setting imports returned ' + im.status);
  }
  /* A cross-origin home is mounted only when that origin answers a CORS preflight for this desktop (spec 302 s6);
     the credential carried there must be audience-bound, which the server side arranges. */
  function originOf(url) { try { var u = new URL(url, CD.origin + '/'); return u.origin; } catch (e) { return ''; } }
  async function vouchedOrigin(base) {
    var origin = originOf(base);
    try {
      var res = await fetch(base + '?objectType', { method: 'GET', headers: { Accept: T_CONTAINER }, credentials: 'omit', mode: 'cors' });
      if (res.ok || res.status === 401 || res.status === 403) { vouchedOrigins[origin] = true; return true; }   // it answered a cross-origin read
      return false;
    } catch (e) { return false; }                                            // network/CORS refusal
  }
  // Vouch every cross-origin disk whose origin has not been vouched yet, then redraw so a now-vouched disk can carry
  // the credential (req/send) and drop its locked look. Best-effort: an origin that refuses the preflight stays
  // credential-free, so its disk reads anonymously.
  function vouchCrossOrigin() {
    var pending = disks.filter(function (d) { return d.crossOrigin && !vouchedOrigins[originOf(d.base)]; });
    if (!pending.length) return;
    Promise.all(pending.map(function (d) { return vouchedOrigin(d.base).catch(function () { return false; }); })).then(function () { drawDisks(); });
  }
  function diskFor(url) {
    var best = null; disks.forEach(function (d) { if (url.indexOf(d.base) === 0 && (!best || d.base.length > best.base.length)) best = d; });
    return best;
  }
  function pathIn(d, url) { return (d.home ? '~/' : '/') + safeDecode(url.slice(d.base.length)); }
  /* The object ID tree "cdmi_objectid/" lives at the server's CDMI binding root, not under a sub-namespace such as
     a home (whose disk base is deeper). home_base (CD_home.base) IS that binding root for the home's origin, so a
     home object's versions and by-ID reads resolve through it; a discovered namespace disk already sits at its
     binding root, so its own base serves. */
  function objectIdBase(url) {
    var d = diskFor(url);
    if (d && d.home && CD_home && CD_home.base) return CD_home.base;
    return d ? d.base : parentOf(url);
  }

  function drawDisks() {
    disksEl.textContent = '';
    disks.slice().sort(function (a, b) { return (b.home ? 1 : 0) - (a.home ? 1 : 0); }).forEach(function (d) {      // home first
      var b = h('button', { class: 'fv-disk' + (d.locked ? ' locked' : '') + (d.home ? ' home' : '') + (d.crossOrigin ? ' cross' : ''), type: 'button', title: (d.home ? 'Home \u00B7 ' : '') + d.base + (d.crossOrigin ? ' \u00B7 another origin' : '') + (d.locked ? ' (sign in to read)' : '') }, [h('i', { html: icon('disk', 48), style: 'display:flex' }), h('span', { text: d.home ? 'Home' : d.name })]);
      d.el = b;
      acceptDrops(b, function () { return d.locked ? null : d.base; });
      b.addEventListener('click', function () { disksEl.querySelectorAll('.sel').forEach(function (n) { n.classList.remove('sel'); }); b.classList.add('sel'); });
      b.addEventListener('dblclick', function () { openContainer(d.base); });
      b.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') openContainer(d.base); });
      b.addEventListener('contextmenu', function (ev) {
        ev.preventDefault();
        popupMenu(ev.clientX, ev.clientY, d.name, [
          { label: 'Open', action: function () { openContainer(d.base); } }, { label: 'Open in xterm', disabled: !findXterm(), action: function () { launchXterm(d.base); } },
          { label: 'Get info', action: function () { infoWindow(d.base); } }, '-',
          { label: 'Unmount', disabled: !d.manual, action: function () { disks.splice(disks.indexOf(d), 1); saveManual(); drawDisks(); } }
        ]);
      });
      disksEl.appendChild(b);
    });
  }

  /* A convenience: where a disk holds one of these applications under /apps/, menus offer it, the capability
     viewer replaces the plain capabilities window, and PDF objects open in the slide presenter. */
  var helpers = { xterm: null, earthworm: null, capabilities: null, console: null, textile: null, xclock: null, capture: null, mdviewer: null, pdfviewer: null, namespaces: null, postcdmi: null, domains: null, relationships: null, servers: null, queues: null, notifications: null, query: null };
  /* Applications are grouped into sub-folders of /apps/: the CDMI applications under /apps/cdmi/, the general
     utilities under /apps/utils/. appPath places a known name in its group; names in neither sit directly at /apps/. */
  var CDMI_APPS = { capabilities: 1, domains: 1, namespaces: 1, postcdmi: 1, queues: 1, relationships: 1, servers: 1, notifications: 1, query: 1 };
  var UTILS_APPS = { console: 1, xterm: 1, capture: 1, framer: 1 };
  function appPath(name) { return CFG.appsDir + (CDMI_APPS[name] ? 'cdmi/' : UTILS_APPS[name] ? 'utils/' : '') + name + '/'; }
  /* Names that open in the text editor where it is installed; so does anything whose media type is text. */
  var TEXT_NAMES = /\.(txt|text|md|markdown|json|log|csv|tsv|xml|ya?ml|toml|ini|conf|cfg|properties|js|mjs|cjs|ts|css|html?|sh|bash|py|rb|pl|c|h|cpp|hpp|java|go|rs|sql|tex|rst|diff|patch)$|^(readme|license|makefile|changelog)$/i;
  function isTextObject(rep, url) { return TEXT_NAMES.test(safeDecode(stripQuery(url).split('/').pop())) || (typeof rep.mimetype === 'string' && isTextual(rep.mimetype) && !/^image\//.test(rep.mimetype)); }
  function findXterm() { return helpers.xterm; }
  function launchXterm(startURL) { if (helpers.xterm) launchApp(helpers.xterm, { start: startURL }); }
  async function locateHelpers() {
    for (var name in helpers) {
      helpers[name] = null;
      var rel = appPath(name);
      for (var i = 0; i < disks.length && !helpers[name]; i++) if (!disks[i].locked && await probeApp(disks[i].base + rel)) helpers[name] = disks[i].base + rel;
    }
  }

  async function rescan() {
    var found = null, problem = null;
    if (!isTLS(CD.origin + '/')) {          // nothing is read, mounted or offered from an origin without TLS
      disks = []; drawDisks();
      var ok = h('button', { class: 'fv-btn', type: 'button', text: 'OK', 'data-autofocus': '' });
      var w = new Win({ title: 'TLS required', w: 500, h: 210, center: true, escCloses: true, content: h('div', { class: 'fv-form' }, [
        h('p', { text: 'This desktop only connects over TLS, and this page came from ' + CD.origin + '. Load it from the https: origin of the CDMI server.' }),
        h('div', { class: 'fv-row end' }, [ok])]) });
      ok.addEventListener('click', function () { w.close(); });
      return;
    }
    await readCapabilities();
    try { found = await discover(); } catch (e) { problem = e.message; }
    // Discovered namespaces are not auto-mounted: only the signed-in principal's home is (mountHome), plus any the
    // user mounted by hand. A discovered "home?" reference is the one exception -- it *is* home, so it is kept.
    // The full discovery result stays available (as `found`) to probe for the home and for the namespaces app.
    var foundHome = (found || []).filter(function (f) { return f.home; });
    disks = foundHome.concat(loadManual().map(function (m) { return { name: m.name, base: m.base, manual: true, crossOrigin: !sameOrigin(m.base) }; })
      .filter(function (m) { return !foundHome.some(function (f) { return f.base === m.base; }); }));
    try { await mountHome(found); } catch (e) { console.warn('[cdmi] home: ' + (e && e.message || e)); }
    drawDisks(); vouchCrossOrigin(); locateHelpers();
    if (!disks.length) {
      if (found === null) connectDialog(problem ? 'Discovery failed: ' + problem + '. Enter a base URI to mount it as a disk.'
        : 'No discovery tree at this origin: GET ' + WELL_KNOWN + 'cdmi_namespaces/ returned 404. Enter a base URI to mount it as a disk.');
      else if (!CD.auth) messageBox('Sign in', 'Sign in from the root menu to see your home.');
      else messageBox('No home', 'This account has no home namespace on this server.');
    }
  }

  /* ------------------------------------------------------------------ applications (index.js in an iframe) */

  var appCache = {};        // container URL -> boolean
  var apps = {};            // id -> Win
  function probeApp(url) {
    if (url in appCache) return Promise.resolve(appCache[url]);
    return req(url + enc(CFG.appEntry) + '?objectName', T_OBJECT, { quiet: true }).then(function (r) { return (appCache[url] = r.ok); }, function () { return false; });
  }

  // Whether a container object itself DEFINES exports and/or imports: the object's own "exports" and "imports"
  // fields, not the read-only "exportsProvided" (which reports exports serving the object, an ancestor's included).
  // Neither field is a childfield, so a listing does not carry them; each container is read once (cached).
  // A lone "self" import layer is not counted -- it only reorders what the container already holds.
  var expImpCache = {};     // container URL -> { exp: <summary|null>, imp: <summary|null> }
  function definedExpImp(rep) {
    var ex = rep && rep.exports, im = rep && rep.imports;
    var exNames = ex && typeof ex === 'object' && !Array.isArray(ex) ? Object.keys(ex) : [];
    var imList = Array.isArray(im) ? im.filter(function (e) { return e && e.type && e.type !== 'self'; }) : [];
    return {
      exp: exNames.length ? exNames.map(function (n) { return n + (ex[n] && ex[n].type ? ' (' + ex[n].type + ')' : ''); }).join(', ') : null,
      imp: imList.length ? imList.map(function (e) { return e.type + (e.import_uri ? ' ' + e.import_uri : ''); }).join(', ') : null
    };
  }
  function probeExpImp(url) {
    if (url in expImpCache) return Promise.resolve(expImpCache[url]);
    return getRep(url + '?exports&imports', ACCEPT_DIR, { quiet: true }).then(function (g) {
      return (expImpCache[url] = definedExpImp(g.rep));
    }, function () { return (expImpCache[url] = { exp: null, imp: null }); });
  }
  // The badge for a container's defined exports/imports: a green out-arrow for an export, a red in-arrow for an
  // import, and a purple two-way arrow where both are defined; nothing where neither is. text/tooltip for each.
  // The arrow is drawn as an SVG rather than a glyph, so it is geometrically centred in the circle (a glyph's ink is
  // not centred in its em box). A diagonal shaft centred on the badge, with an out-arrowhead (NE) for an export, an
  // in-arrowhead (SW) for an import, and both heads where both are defined.
  function arrowSvg(cls) {
    var shaft = 'M2.6 9.4 L9.4 2.6', headNE = 'M9.4 2.6 L6.1 2.6 M9.4 2.6 L9.4 5.9', headSW = 'M2.6 9.4 L5.9 9.4 M2.6 9.4 L2.6 6.1';
    var d = shaft + ' ' + (cls === 'imp' ? headSW : cls === 'both' ? headNE + ' ' + headSW : headNE);
    return '<svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" style="display:block"><path d="' + d + '"/></svg>';
  }
  function badgeFor(info) {
    if (!info) return null;
    if (info.exp && info.imp) return { cls: 'both', tip: 'exports defined: ' + info.exp + '  ·  imports defined: ' + info.imp };
    if (info.exp) return { cls: 'exp', tip: 'exports defined: ' + info.exp };
    if (info.imp) return { cls: 'imp', tip: 'imports defined: ' + info.imp };
    return null;
  }

  /* index.png beside index.js, as a blob: URL. iconKnown records what a listing said, so nothing is
     asked for where a listing already showed there is no icon. */
  var iconKnown = {}, iconCache = {};
  function loadIcon(containerURL) {
    if (iconKnown[containerURL] === false) return Promise.resolve(null);
    if (!iconCache[containerURL]) iconCache[containerURL] = readObject(containerURL + enc(CFG.appIcon), { quiet: true }).then(readValue).then(function (v) {
      if (!v.bytes || !v.bytes.length) return null;
      return URL.createObjectURL(new Blob([v.bytes], { type: /^image\//.test(v.mime) ? v.mime : 'image/png' }));
    }).catch(function () { return null; });
    return iconCache[containerURL];
  }
  function iconImg(src, size) { return h('img', { src: src, width: size, height: size, alt: '', draggable: 'false', style: 'display:block;object-fit:contain' }); }

  /* ------------------------------------------------------------------ app resource forks (rsrc/) */
  // A resource fork is a container of typed resources. A DATA OBJECT directly under rsrc/ is a COLLECTION: its JSON
  // value is an {id: value} map (strings, caps, tokens, schemas, menus, layouts, data). A CONTAINER under rsrc/ is a
  // PER-OBJECT category: one object per id, each carrying its own value (icons, images, code, styles, text).
  //
  // The whole fork reads in ONE combined recursive + extended listing (seedmi >= 0.116): `?childrecursive` (no depth =
  // the whole tree) with childfields naming the value, so every collection's value and every per-object category's
  // objects come back in one request. A container child's descendants are nested as a trailing array member of the
  // child's own tuple (revision 365 Clause 7). Where that combination is refused (an older server: 0.115 serves value
  // in a one-level listing but refuses the recursive combination; earlier still, neither), it falls back to one
  // extended listing of rsrc/ plus one per per-object category, and finally to per-object reads. Values decode by
  // mimetype / valuetransferencoding; a resource's own metadata is not loaded.
  var RSRC_FIELDS = ['objectName', 'objectType', 'value', 'valuetransferencoding', 'mimetype'];
  var rsrcCache = {};       // fork URL -> Promise({ <category>: { kind:'collection', data } | { kind:'object', items } })
  function forkVal(tuple, at) { return { value: tuple[at.value], enc: (at.valuetransferencoding !== undefined && tuple[at.valuetransferencoding]) || 'utf-8', mimetype: (at.mimetype !== undefined && tuple[at.mimetype]) || '' }; }
  function forkCollection(v) { try { return typeof v === 'string' ? JSON.parse(v) : (v && typeof v === 'object' ? v : {}); } catch (e) { return {}; } }
  function forkAt(fields) { var at = {}; fields.forEach(function (f, i) { at[f] = i; }); return at; }
  // The trailing member a container child's tuple carries in a nested recursive listing: it sits after every named
  // field, and is the only array among the fields (objectName/value/vte/mimetype are scalars), so it is recognized by
  // being an array at or past the named-field count.
  function forkNested(tuple, at) { for (var i = RSRC_FIELDS.length; i < tuple.length; i++) if (Array.isArray(tuple[i])) return tuple[i]; return null; }
  function forkCatItems(under, at) {
    var items = {};
    (under || []).forEach(function (e) { if (!Array.isArray(e)) return; var n = e[at.objectName] || ''; if (!n || /\/$/.test(n)) return; items[n] = forkVal(e, at); });
    return items;
  }
  // Parse a top-level recursive listing (each entry a tuple, containers carrying a nested children array) into the map.
  function forkFromRecursive(kids, at) {
    var out = {};
    kids.forEach(function (t) {
      if (!Array.isArray(t)) return;
      var nm = t[at.objectName] || ''; if (!nm) return;
      var isC = /\/$/.test(nm) || t[at.objectType] === T_CONTAINER, bare = nm.replace(/\/$/, '');
      if (isC) out[bare] = { kind: 'object', items: forkCatItems(forkNested(t, at) || [], at) };
      else out[bare] = { kind: 'collection', data: forkCollection(forkVal(t, at).value) };
    });
    return out;
  }
  function loadRsrcFork(forkURL) {
    forkURL = stripQuery(String(forkURL || '')); if (!/\/$/.test(forkURL)) forkURL += '/';
    if (forkURL in rsrcCache) return rsrcCache[forkURL];
    return (rsrcCache[forkURL] = (async function () {
      var at = forkAt(RSRC_FIELDS);
      // Fast path: one combined recursive + extended listing.
      var res = await req(forkURL + '?childrecursive&childfields=' + RSRC_FIELDS.join(';') + '&children=0-9999', ACCEPT_DIR, { quiet: true, probe: true });
      if (res.ok) {
        var kids = (await res.json()).children || [];
        if (!kids.length) return {};
        if (Array.isArray(kids[0])) return forkFromRecursive(kids, at);   // extended tuples: parse the nested tree
        // plain names (childfields ignored): fall through to the per-listing path
      } else if (res.status === 404) { return {}; }
      else if (res.status !== 400 && res.status !== 409) { throw await toError(res); }
      return await loadRsrcForkSlow(forkURL, at);
    })().catch(function (e) { delete rsrcCache[forkURL]; throw e; }));
  }
  // The pre-0.116 path: one extended listing of rsrc/ (value per collection, type per child) plus one extended listing
  // per per-object category, with a per-object read where a listing does not carry the value.
  async function loadRsrcForkSlow(forkURL, at) {
    var out = {}, containers = [];
    var res = await req(forkURL + '?childfields=' + RSRC_FIELDS.join(';') + '&children=0-9999', ACCEPT_DIR, { quiet: true, probe: true });
    if (!res.ok) { if (res.status === 404) return out; throw await toError(res); }
    var kids = (await res.json()).children || [];
    if (kids.length && Array.isArray(kids[0])) {
      kids.forEach(function (t) {
        var nm = t[at.objectName] || ''; if (!nm) return;
        if (/\/$/.test(nm) || t[at.objectType] === T_CONTAINER) { containers.push(nm.replace(/\/$/, '')); return; }
        out[nm] = { kind: 'collection', data: forkCollection(forkVal(t, at).value) };
      });
    } else {
      var names = normChildren(kids, null);
      for (var i = 0; i < names.length; i++) {
        var nm0 = names[i].name;
        if (/\/$/.test(nm0)) { containers.push(nm0.replace(/\/$/, '')); continue; }
        out[nm0] = { kind: 'collection', data: forkCollection((await getLeaf(forkURL + enc(nm0), { quiet: true })).rep.value) };
      }
    }
    var cf = ['objectName', 'value', 'valuetransferencoding', 'mimetype'], cat2 = forkAt(cf);
    for (var c = 0; c < containers.length; c++) {
      var cat = containers[c], items = {};
      var cres = await req(forkURL + enc(cat) + '/?childfields=' + cf.join(';') + '&children=0-9999', ACCEPT_DIR, { quiet: true });
      if (cres.ok) {
        var cch = (await cres.json()).children || [];
        if (cch.length && Array.isArray(cch[0])) {
          for (var k = 0; k < cch.length; k++) {
            var tn = cch[k][cat2.objectName] || ''; if (!tn || /\/$/.test(tn)) continue;
            var it = forkVal(cch[k], cat2);
            if (it.value === undefined || it.value === null) { var gg = await getLeaf(forkURL + enc(cat) + '/' + enc(tn), { quiet: true }); it = { value: gg.rep.value, enc: gg.rep.valuetransferencoding || 'utf-8', mimetype: gg.rep.mimetype || '' }; }
            items[tn] = it;
          }
        } else {
          var cn = normChildren(cch, null);
          for (var m = 0; m < cn.length; m++) { var tn2 = cn[m].name.replace(/\/$/, ''); var g2 = await getLeaf(forkURL + enc(cat) + '/' + enc(tn2), { quiet: true }); items[tn2] = { value: g2.rep.value, enc: g2.rep.valuetransferencoding || 'utf-8', mimetype: g2.rep.mimetype || '' }; }
        }
      }
      out[cat] = { kind: 'object', items: items };
    }
    return out;
  }
  // An app's own fork is containerURL + rsrc/. The shared SYSTEM fork lives in the desktop container (where cvwm.js
  // and index.html are served from); the running desktop cannot derive that container's binding path on its own (it is
  // served through an HTTP export at an unrelated path), so install writes the fork's absolute URL onto the script tag
  // as data-rsrc. Absent (an older or hand install), there is no system fork and every app runs on its own resources.
  function appForkURL(containerURL) { return stripQuery(containerURL).replace(/\/?$/, '/') + 'rsrc/'; }
  function systemForkURL() { var u = attr('data-rsrc'); return u ? (/\/$/.test(u) ? u : u + '/') : null; }

  async function launchApp(containerURL, extra) {
    var d = diskFor(containerURL), label = (d ? d.name + ':' + pathIn(d, containerURL) : containerURL);
    try {
      var got = await readObject(containerURL + enc(CFG.appEntry)), val = await readValue(got);
      var source = val.text !== undefined ? val.text : bytesToText(val.bytes);
      var id = 'app' + (++uid), blob = URL.createObjectURL(new Blob([source + '\n//# sourceURL=' + containerURL + CFG.appEntry], { type: 'text/javascript' }));
      var proc = extra && extra.process;          // started as a command: argv, cwd, and somewhere to write (see DEVELOPERS.md)
      var home = homeDisk();
      // Resource fork: warm the app's own fork (parent-side, where the credential is). Empty => a classic app, and the
      // rsrc plumbing is skipped so it behaves exactly as before. A fork app also warms the shared system fork (cached
      // once for every app that shares it). The iframe builds CTX.rsrc / CTX.sys.rsrc from these same cached loads.
      var appFork = appForkURL(containerURL), sysFork = systemForkURL(), hasRsrc = false;
      try { hasRsrc = Object.keys(await loadRsrcFork(appFork)).length > 0; } catch (e) { hasRsrc = false; }
      if (hasRsrc && sysFork) { try { await loadRsrcFork(sysFork); } catch (e) { /* no system fork; CTX.sys.rsrc resolves nothing */ } }
      var ctx = { id: id, origin: CD.origin, containerURI: containerURL, baseURI: d ? d.base : containerURL, diskName: d ? d.name : '', homeURI: home ? home.base : null, startURI: (extra && extra.start) || null,
        namespaces: disks.map(function (x) { return { name: x.name, baseURI: x.base }; }), headers: CD.auth ? { Authorization: CD.auth } : {},
        principal: (CD.userinfo && CD.userinfo.identifier) || null, mcpUri: (CD.caps && CD.caps.cdmi_mcp_uri) || null,
        __entry: blob, __hasRsrc: hasRsrc, __appFork: appFork, __sysFork: sysFork };
      var json = JSON.stringify(ctx).replace(/</g, '\\u003c');
      // The resource manager, built inside the iframe over the maps the parent loaded, so realm-sensitive work (a code
      // module's data: URL import) runs in the app's realm. text/json/dataURL/ids/has are synchronous; module() is async.
      var mkMgr = 'function mkMgr(map){map=map||{};var mc={};' +
        'function E(c,i){var k=map[c];if(!k)return;if(k.kind==="collection"){return (i in (k.data||{}))?{v:k.data[i],coll:1}:undefined;}var it=(k.items||{})[i];return it?{v:it,coll:0}:undefined;}' +
        'function B(b){try{return decodeURIComponent(escape(atob(String(b).replace(/\\s+/g,""))));}catch(e){try{return atob(String(b));}catch(_){return "";}}}' +
        'return{text:function(c,i){var e=E(c,i);if(!e)return undefined;if(e.coll)return e.v==null?undefined:String(e.v);return e.v.enc==="base64"?B(e.v.value):(e.v.value==null?"":String(e.v.value));},' +
        'json:function(c,i){var e=E(c,i);if(!e)return undefined;if(e.coll)return e.v;var t=e.v.enc==="base64"?B(e.v.value):e.v.value;try{return typeof t==="string"?JSON.parse(t):t;}catch(x){return undefined;}},' +
        'dataURL:function(c,i){var e=E(c,i);if(!e||e.coll)return undefined;var v=e.v;return v.enc==="base64"?("data:"+(v.mimetype||"application/octet-stream")+";base64,"+String(v.value||"").replace(/\\s+/g,"")):("data:"+(v.mimetype||"text/plain")+";charset=utf-8,"+encodeURIComponent(v.value==null?"":String(v.value)));},' +
        'module:function(c,i){var k=c+"/"+i;if(mc[k])return mc[k];var e=E(c,i);if(!e||e.coll)return (mc[k]=Promise.reject(new Error("no code resource "+k)));var s=e.v.enc==="base64"?B(e.v.value):String(e.v.value||"");return (mc[k]=import("data:text/javascript;base64,"+btoa(unescape(encodeURIComponent(s)))));},' +
        'ids:function(c){var k=map[c];if(!k)return [];return Object.keys(k.kind==="collection"?(k.data||{}):(k.items||{}));},' +
        'has:function(c,i){return E(c,i)!==undefined;}};}';
      var doc = '<!doctype html><html><head><meta charset="utf-8"><base href="' + containerURL.replace(/"/g, '%22') + '"><title>' + label.replace(/[<&]/g, '') + '</title>' +
        '<style>' + SCROLLBAR_CSS + '\nhtml,body{margin:0;height:100%;background:#000;color:#ddd}</style><script>(function(){var D=parent.cvwm,c=' + json + ';' +
        'c.setTitle=function(t){D.app(c.id,"title",String(t))};c.resize=function(w,h){D.app(c.id,"resize",[+w,+h])};c.aspect=function(r){D.app(c.id,"aspect",+r||0)};c.setDirty=function(d){D.app(c.id,"dirty",!!d)};c.close=function(){D.app(c.id,"close")};c.open=function(u){D.app(c.id,"open",String(u))};' +
        'D.capture(window,c.id);c.desktop=D;c.net=D.netFor(c.id);var p=D.app(c.id,"process");if(p){c.argv=p.argv;c.cwd=p.cwd;c.stdout=p.stdout;c.stderr=p.stderr;c.shell=p.shell;c.exit=function(n){D.app(c.id,"exit",n|0)};}' +
        mkMgr +
        'function run(){var s=document.createElement("script");s.src=c.__entry;(document.body||document.documentElement).appendChild(s);}' +
        'window.CDMI_CONTEXT=c;' +
        'if(c.__hasRsrc){Promise.all([D.loadRsrc(c.__appFork),c.__sysFork?D.loadRsrc(c.__sysFork).catch(function(){return {};}):Promise.resolve({})]).then(function(r){c.rsrc=mkMgr(r[0]);c.sys={rsrc:mkMgr(r[1])};},function(){c.rsrc=mkMgr({});c.sys={rsrc:mkMgr({})};}).then(run);}else{run();}' +
        '})();<\/script></head><body></body></html>';
      var frame = h('iframe', { title: label, allow: 'fullscreen' });        // so an application may present full screen
      var w = new Win({ title: label, icon: 'app', w: 720, h: 420, minW: 260, minH: 140, content: frame, onClose: function () { delete apps[id]; URL.revokeObjectURL(blob); if (proc && proc.onExit) { try { proc.onExit(w.exitCode || 0); } catch (e) { console.error(e); } } } });
      w.process = proc || null;
      w.extraMenu = function () { return [{ label: 'Browse contents', action: function () { openContainer(containerURL, { browse: true }); } }, { label: 'Restart', action: function () { frame.srcdoc = doc; } }]; };
      apps[id] = w; w.containerURI = containerURL;
      loadIcon(containerURL).then(function (src) { if (src) w.setIcon(src); });
      // Native "open a Markdown file" pane, shown before the app has a document. It is a real desktop element, so a
      // dropped host file or a dragged cvwm object lands on it directly (an iframe cannot see an internal cvwm drag).
      // dropPaneHandlers[id] = { onFile(file), onObject(url) }; showApp(id) swaps to the iframe once a document loads.
      dropPanes[id] = { frame: frame, pane: null, w: w };
      function appCtx() { try { return frame.contentWindow.CDMI_CONTEXT || {}; } catch (e) { return {}; } }
      w.dropTarget = function () { var f = appCtx().dropTarget; try { return typeof f === 'function' ? f() || null : null; } catch (e) { return null; } };
      w.dropDone = function (results, to) { var f = appCtx().onUpload; if (typeof f === 'function') { try { f(results, to); } catch (e) { console.error(e); } } };
      // An app may accept a dragged CDMI data object itself (rather than have it moved into a container): it defines
      // CTX.onObjectDrop(info), and optionally CTX.objectDropHint (the verb shown on hover, e.g. "Enqueue"). The whole
      // app window is then the target for an object drag -- the iframe cannot see an internal drag, so the window
      // catches it (over/drop below) and hands the object's {url,name,kind,type} to the app. Data objects only.
      w.wantsObjectDrop = function () { return typeof appCtx().onObjectDrop === 'function'; };
      w.objectDropHint = function () { var v = appCtx().objectDropHint; return typeof v === 'string' && v ? v : 'Add'; };
      w.objectDrop = function (info) { var f = appCtx().onObjectDrop; if (typeof f === 'function') { try { f(info); } catch (e) { console.error(e); } } };
      frame.addEventListener('load', function () {
        try {   // clicks inside a same-origin iframe never reach us, so listen there to raise and focus
          frame.contentWindow.addEventListener('pointerdown', function () { closeMenus(); w.raise(); focusWin(w); }, true);
          if (WM.focused === w) frame.contentWindow.focus();
        } catch (e) { /* the app navigated somewhere else */ }
      });
      frame.srcdoc = doc;
      return w;
    } catch (e) { messageBox('Cannot run ' + label, e.message); }
  }

  /* ------------------------------------------------------------------ object viewers */

  function hexdump(bytes, limit) {
    var out = [], n = Math.min(bytes.length, limit);
    for (var o = 0; o < n; o += 16) {
      var hx = '', as = '';
      for (var i = 0; i < 16; i++) {
        if (o + i < n) { var b = bytes[o + i]; hx += (b < 16 ? '0' : '') + b.toString(16) + ' '; as += b >= 32 && b < 127 ? String.fromCharCode(b) : '.'; } else hx += '   ';
        if (i === 7) hx += ' ';
      }
      out.push(('0000000' + o.toString(16)).slice(-8) + '  ' + hx + ' ' + as);
    }
    if (bytes.length > n) out.push('\u2026 ' + (bytes.length - n) + ' more bytes');
    return out.join('\n');
  }

  function describe(rep) { var md = rep.metadata || {}; return [rep.objectType, typeof rep.mimetype === 'string' ? rep.mimetype : null, md.cdmi_size !== undefined ? md.cdmi_size + ' bytes' : null, rep.objectID].filter(Boolean).join(' \u00B7 '); }

  async function openObject(url, name, into, rethrow, plain, titled) {
    try {
      if (helpers.pdfviewer && /\.pdf$/i.test(stripQuery(url))) return launchApp(helpers.pdfviewer, { start: url });   // pdfviewer reads it itself with the browser's PDF renderer
      var got = await getLeaf(url), rep = got.rep, d = diskFor(got.url), title = titled || (d ? d.name + ':' + pathIn(d, got.url) : (name || got.url));
      if (rep.objectType === T_CONTAINER || rep.objectType === T_CAPABILITY || rep.objectType === T_DOMAIN) return openContainer(/\/$/.test(got.url) ? got.url : got.url + '/', { into: into });
      if (helpers.pdfviewer && !plain && rep.objectType !== T_QUEUE && (/\.pdf$/i.test(stripQuery(got.url)) || rep.mimetype === 'application/pdf')) return launchApp(helpers.pdfviewer, { start: got.url });
      if (helpers.mdviewer && !plain && rep.objectType !== T_QUEUE && (/\.(md|markdown|mdown|mkd)$/i.test(stripQuery(got.url)) || rep.mimetype === 'text/markdown')) return launchApp(helpers.mdviewer, { start: got.url });
      if (helpers.textile && !plain && rep.objectType !== T_QUEUE && isTextObject(rep, got.url)) return launchApp(helpers.textile, { start: got.url });
      if (rep.objectType === T_QUEUE) return helpers.queues ? launchApp(helpers.queues, { start: got.url }) : textWindow(title, JSON.stringify(rep, null, 2), { icon: 'queue', status: describe(rep) });
      if (!got.raw) { var full = await readObject(got.url); rep = Object.assign({}, rep, full.rep); got = full; }      // the first read described it; this one selects the value
      var val = await readValue(got);
      if (/^image\//.test(val.mime) && val.bytes) {
        var src = URL.createObjectURL(new Blob([val.bytes], { type: val.mime }));
        return new Win({ title: title, icon: 'image', w: 480, h: 380, onClose: function () { URL.revokeObjectURL(src); },
          content: h('div', { style: 'flex:1;display:flex;flex-direction:column;min-height:0' }, [h('div', { class: 'fv-img' }, [h('img', { src: src, alt: name || title })]), h('div', { class: 'fv-status', text: describe(rep) })]) });
      }
      if (val.text !== undefined) return textWindow(title, val.text, { status: describe(rep) });
      if (isTextual(val.mime)) return textWindow(title, bytesToText(val.bytes), { status: describe(rep) });
      return textWindow(title, hexdump(val.bytes, 8192), { hex: true, status: describe(rep) });
    } catch (e) { if (rethrow) throw e; messageBox('Cannot open ' + (name || url), e.message); }
  }

  async function infoWindow(url) {
    try {
      var got = /\/$/.test(url) ? await getRep(url, ACCEPT_DIR) : await getLeaf(url), rep = Object.assign({}, got.rep);
      // Get info describes an object, not its contents: the value (and the fields that only describe it) are left out.
      delete rep.value; delete rep.valuetransferencoding; delete rep.valuerange;
      if (Array.isArray(rep.children) && rep.children.length > 50) rep.children = rep.children.slice(0, 50).concat(['\u2026']);
      var d = diskFor(got.url);
      textWindow('Info \u00B7 ' + (d ? d.name + ':' + pathIn(d, got.url) : got.url), JSON.stringify(rep, null, 2), { w: 480, h: 360 });
    } catch (e) { messageBox('No info', e.message); }
  }

  /* ------------------------------------------------------------------ container browser */

  async function openContainer(url, o) {
    o = o || {};
    var d = diskFor(url);
    if (!o.browse && d && url === d.base + 'cdmi_objectid/') return objectIdDialog(d, o.into);
    if (!o.browse && await probeApp(url)) return launchApp(url);
    var b = o.into || new Browser();
    b.show(url);
    return b;
  }

  function Browser() {
    var self = this;
    this.up = h('button', { class: 'fv-btn sm', type: 'button', text: 'Up', title: 'Parent container' });
    this.refresh = h('button', { class: 'fv-refresh', type: 'button', title: 'Read this container again', 'aria-label': 'Refresh', html: VIEW_ICONS.reload });
    this.path = h('input', { class: 'fv-in', type: 'text', 'aria-label': 'Path', spellcheck: 'false', autocomplete: 'off' });
    this.grid = h('div', { class: 'fv-grid', tabindex: '0' });
    this.status = h('div', { class: 'fv-status', text: '' });
    this.view = 'icons'; try { if (localStorage.getItem(VIEW_KEY) === 'list') this.view = 'list'; } catch (e) { /* no storage */ }
    this.sort = null;                                  // { key, dir } once a column heading has been clicked
    this.bIcons = h('button', { type: 'button', title: 'Icon view', 'aria-label': 'Icon view', html: VIEW_ICONS.icons });
    this.bList = h('button', { type: 'button', title: 'List view', 'aria-label': 'List view', html: VIEW_ICONS.list });
    this.bIcons.addEventListener('click', function () { self.setView('icons'); }); this.bList.addEventListener('click', function () { self.setView('list'); });
    this.win = new Win({ title: 'browser', icon: 'container', w: 600, h: 360, minW: 280, minH: 180,
      content: h('div', { style: 'flex:1;display:flex;flex-direction:column;min-height:0' }, [h('div', { class: 'fv-bar' }, [this.up, this.refresh, this.path, h('div', { class: 'fv-views', role: 'group', 'aria-label': 'View' }, [this.bIcons, this.bList])]), this.grid, this.status]) });
    this.setView(this.view, true);
    browsers.push(this); this.win.isBrowser = true;
    this.win.onClose = function () { var i = browsers.indexOf(self); if (i >= 0) browsers.splice(i, 1); };
    this.win.dropTarget = function () { return self.url && self.isContainer ? self.url : null; };
    this.win.dropProgress = function (text) { self.status.textContent = text; };
    this.win.dropDone = function (results) {
      var ok = results.filter(function (r) { return r.outcome === 'created' || r.outcome === 'replaced'; }).length;
      self.show(self.url).then(function () { self.status.textContent = ok + (ok === 1 ? ' file' : ' files') + ' uploaded \u00B7 ' + self.baseStatus; });
    };
    this.win.extraMenu = function () { return self.bgMenu(); };
    this.up.addEventListener('click', function () { if (self.disk && self.url !== self.disk.base) self.show(self.url.replace(/[^\/]+\/$/, '')); });
    this.refresh.addEventListener('click', function () { self.show(self.url); });
    this.path.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Enter' || !self.disk) return;
      var p = self.path.value.trim().replace(/^\/+/, ''); if (p && !/\/$/.test(p)) p += '/';
      openContainer(self.disk.base + p.split('/').map(enc).join('/'), { into: self });
    });
    this.grid.addEventListener('pointerdown', function (ev) { if (ev.target === self.grid) self.select(null); });
    // A right-click on the empty background of the container view offers what can be created here.
    this.grid.addEventListener('contextmenu', function (ev) {
      if (ev.target !== self.grid && !(ev.target.closest && ev.target.closest('.fv-note'))) return;    // items carry their own menu
      if (!self.isContainer) return;
      ev.preventDefault(); self.select(null);
      popupMenu(ev.clientX, ev.clientY, 'This container', self.bgMenu());
    });
  }
  /* The menu for the container itself: shown from the window menu and from a right-click on the empty background. */
  Browser.prototype.bgMenu = function () {
    var self = this;
    return [
      { label: 'New container…', disabled: !self.isContainer, action: function () { newNamedContainer(self); } },
      { label: 'New text file', disabled: !helpers.textile || !self.isContainer, action: function () { launchApp(helpers.textile, { start: self.url }); } },
      { label: 'Reload', action: function () { self.show(self.url); } }
    ].concat(self.isContainer ? objectMenu(self.url, 'container', false, T_CONTAINER) : [], [{ label: 'Get info', action: function () { infoWindow(self.url); } }]);
  };
  /* Icon view or list view. The list needs each child's size and time of modification, which the icon view
     does not ask for, so the first change to it reads the container again with those fields. */
  Browser.prototype.setView = function (view, quietly) {
    this.view = view;
    this.bIcons.setAttribute('aria-pressed', String(view === 'icons')); this.bList.setAttribute('aria-pressed', String(view === 'list'));
    this.grid.classList.toggle('as-list', view === 'list');
    if (quietly) return;
    try { localStorage.setItem(VIEW_KEY, view); } catch (e) { /* no storage; the choice lasts for this window */ }
    if (!this.listing) return;
    if (view === 'list' && !this.listing.detailed && CD.listMode[this.disk ? this.disk.base : this.url] !== 'plain') this.show(this.url); else this.render(this.listing);
  };
  Browser.prototype.select = function (el) { this.grid.querySelectorAll('.sel').forEach(function (n) { n.classList.remove('sel'); }); if (el) el.classList.add('sel'); else this.status.textContent = this.baseStatus || ''; };
  Browser.prototype.note = function (text, button) { this.grid.textContent = ''; this.grid.appendChild(h('div', { class: 'fv-note' }, [h('div', { text: text }), button ? h('div', { style: 'margin-top:10px' }, [button]) : null])); };

  Browser.prototype.show = async function (url) {
    var self = this, token = (this.token = (this.token || 0) + 1);
    this.status.textContent = 'Reading ' + url + ' \u2026';
    try {
      // Always ask for the detailed (extended) listing, so each child's metadata -- including its lock state -- comes in
      // the one listing rather than a request per child. (Icon view used to read a plain listing and probe each child.)
      var d = diskFor(url), list = await listContainer(url, d ? d.base : url, true);
      if (token !== this.token || this.win.closed) return;
      this.url = list.url; this.disk = diskFor(list.url) || d; this.isContainer = !list.rep.objectType || list.rep.objectType === T_CONTAINER;
      if (this.disk && this.disk.el) { this.disk.locked = false; this.disk.el.classList.remove('locked'); this.disk.el.firstChild.innerHTML = icon('diskOpen', 48); }
      var p = this.disk ? pathIn(this.disk, this.url) : this.url;
      this.win.setTitle((this.disk ? (this.disk.home ? 'Home ' : this.disk.name + ': ') : '') + p); this.path.value = p;
      this.up.disabled = !this.disk || this.url === this.disk.base;
      this.render(list);
    } catch (e) {
      if (token !== this.token) return;
      // First access determines a disk's locked state, which discovery deferred: a 401/403 marks it locked (a
      // successful read above unlocks it). d is diskFor(url), assigned before the read that threw.
      if ((e.status === 401 || e.status === 403) && d && d.el) { d.locked = true; d.el.classList.add('locked'); d.el.firstChild.innerHTML = icon('disk', 48); }
      this.status.textContent = e.message;
      var again = h('button', { class: 'fv-btn', type: 'button', text: e.status === 401 || e.status === 403 ? 'Sign in\u2026' : 'Retry' });
      again.addEventListener('click', function () { if (e.status === 401 || e.status === 403) signInDialog().then(function (ok) { if (ok) self.show(url); }); else self.show(url); });
      this.note('Could not read ' + url + ' \u2014 ' + e.message, again);
      if (!this.url) this.win.setTitle(url);
    }
  };

  function typeLabel(c) {
    if (c.kind === 'reference') return 'Reference';
    if (c.kind === 'queue') return 'Queue';
    if (c.kind === 'container') return c.type === T_CAPABILITY ? 'Capabilities' : c.type === T_DOMAIN ? 'Domain' : 'Container';
    return c.mime || 'Data object';
  }
  function sizeLabel(n) {
    if (n === null || n === undefined) return '\u2014';
    if (n < 1024) return n + ' B';
    var units = ['KB', 'MB', 'GB', 'TB'], v = n / 1024, u = 0; while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
    return (v < 10 ? v.toFixed(1) : Math.round(v)) + ' ' + units[u];
  }
  function whenLabel(iso) {
    if (!iso) return '\u2014';
    var d = new Date(iso); if (isNaN(d)) return iso;
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  /* What can be defined on an object: exports and imports for containers, data objects and queues, and snapshots for
     containers. A plain listing does not tell a queue from a data object; the dialog finds out. */
  function dacSupported() { return !!(CD.caps && (CD.caps.cdmi_dac === 'true' || CD.caps.cdmi_dac === true)); }
  /* Delete an object. Retention and hold are checked first and explained, since a retained or held object is not
     deleted until the period passes or the hold is released; otherwise the deletion is confirmed and performed, and
     any browser showing the parent container is refreshed. */
  async function deleteObject(url, kind, label) {
    var isC = kind === 'container';
    var lock = await probeLock(url).catch(function () { return null; });
    if (lock && lock.restricted) {
      var why = lock.held && lock.retained ? 'it is retained and under ' + lock.holds.length + (lock.holds.length === 1 ? ' hold' : ' holds')
        : lock.held ? 'it is under ' + lock.holds.length + (lock.holds.length === 1 ? ' hold' : ' holds')
        : 'it is retained' + (lock.retainedUntil ? ' until ' + new Date(lock.retainedUntil).toISOString() : '');
      messageBox('Cannot delete ' + label, label + ' cannot be deleted because ' + why + ' — a retention period ends on its own, and a hold is released outside CDMI.');
      return;
    }
    if (!(await confirmBox('Delete?', 'Delete ' + label + (isC ? ' and everything it holds' : '') + '? This cannot be undone.', 'Delete', 'Cancel'))) return;
    try {
      var res = await send('DELETE', url, isC ? T_CONTAINER : kind === 'queue' ? T_QUEUE : T_OBJECT);
      if (!res.ok) throw await toError(res);
      var parent = parentOf(stripQuery(url).replace(/\/$/, ''));
      [url, parent].forEach(function (u) { delete appCache[u]; delete iconCache[u]; delete iconKnown[u]; delete expImpCache[u]; delete expImpCache[stripQuery(u)]; delete lockCache[stripQuery(u)]; });
      browsers.forEach(function (b) { if (b.win.closed) return; if (b.url === parent) b.show(b.url); else if (isC && b.url === url) b.show(parent); });
    } catch (e) { messageBox('Cannot delete ' + label, (e && e.message) || String(e)); }
  }

  /* A tag chip editor: chips in, array out, modelled on the ACL builder's { el, value() } shape so it drops into any
     form. Enter or comma commits a chip; Backspace on an empty field removes the last; the × on a chip removes it. */
  function tagEditor(initial) {
    var tags = (Array.isArray(initial) ? initial.slice() : []).map(String);
    var wrap = h('div', { style: 'display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:6px;background:#fff;border:2px solid;border-color:rgba(0,0,0,.55) rgba(255,255,255,.6) rgba(255,255,255,.6) rgba(0,0,0,.55);min-height:30px;box-sizing:border-box' });
    var input = h('input', { class: 'fv-in', type: 'text', placeholder: 'add a tag…', spellcheck: 'false', autocomplete: 'off', style: 'flex:1;min-width:100px;height:22px;border:none' });
    function draw() {
      wrap.textContent = '';
      tags.forEach(function (t, i) {
        var x = h('button', { type: 'button', title: 'remove', text: '×', style: 'border:none;background:transparent;color:#fff;font:700 14px sans-serif;line-height:1;cursor:pointer;padding:0 2px' });
        x.addEventListener('click', function () { tags.splice(i, 1); draw(); });
        wrap.appendChild(h('span', { style: 'display:inline-flex;align-items:center;gap:3px;background:#60a0c0;color:#fff;padding:2px 4px 2px 9px;border-radius:10px;font:12px Helvetica,Arial,sans-serif' }, [h('span', { text: t }), x]));
      });
      wrap.appendChild(input);
    }
    function add() { var v = input.value.trim().replace(/,+$/, '').trim(); if (v && tags.indexOf(v) < 0) tags.push(v); input.value = ''; draw(); input.focus(); }
    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' || ev.key === ',') { ev.preventDefault(); add(); }
      else if (ev.key === 'Backspace' && !input.value && tags.length) { tags.pop(); draw(); input.focus(); }
    });
    input.addEventListener('blur', function () { if (input.value.trim()) add(); });
    wrap.addEventListener('pointerdown', function (ev) { if (ev.target === wrap) { ev.preventDefault(); input.focus(); } });
    draw();
    return { el: wrap, value: function () { return tags.slice(); } };
  }

  /* Edit an object's tags -- the cvwm_tags metadata array. Read the current array (tolerating a legacy delimited
     string), edit it as chips, and PATCH the whole array back (an array metadata item is replaced wholesale); an
     empty set clears the item. A smart folder whose scope has a "cvwm_tags has tag X" condition gathers these. */
  async function tagsWindow(url, kind) {
    var type = (/\/$/.test(stripQuery(url)) || kind === 'container') ? T_CONTAINER : T_OBJECT;
    var initial = [];
    try {
      var got = await getLeaf(url + '?metadata=cvwm_tags', { quiet: true });
      var v = ((got.rep && got.rep.metadata) || {}).cvwm_tags;
      if (Array.isArray(v)) initial = v;
      else if (typeof v === 'string' && v) { try { var p = JSON.parse(v); initial = Array.isArray(p) ? p : v.split(/[,\s]+/); } catch (e) { initial = v.split(/[,\s]+/); } }
      initial = initial.map(String).filter(Boolean);
    } catch (e) { /* none yet */ }
    var ed = tagEditor(initial);
    var status = h('p', {});
    var cancel = h('button', { class: 'fv-btn', type: 'button', text: 'Cancel' });
    var ok = h('button', { class: 'fv-btn', type: 'button', text: 'Save', 'data-autofocus': '' });
    var label = (function () { var d = diskFor(url); return d ? d.name + ':' + pathIn(d, url) : url; })();
    var w = new Win({ title: 'Tags · ' + label, w: 460, h: 250, center: true, escCloses: true,
      content: h('div', { class: 'fv-form' }, [
        h('p', { text: 'Tags are stored as the cvwm_tags metadata array. Gather everything with a tag using a smart folder (query: metadata key cvwm_tags, has tag).' }),
        ed.el, status,
        h('div', { class: 'fv-row end' }, [cancel, h('span', { style: 'flex:1' }), ok]) ]) });
    cancel.addEventListener('click', function () { w.close(); });
    ok.addEventListener('click', async function () {
      ok.disabled = true; status.textContent = 'Saving…';
      var tags = ed.value(), body = { metadata: { cvwm_tags: tags.length ? tags : null } };   // whole-array replace; null clears
      try { var res = await send('PATCH', url, type, JSON.stringify(body)); if (!res.ok) throw await toError(res); w.close(); }
      catch (e) { ok.disabled = false; status.textContent = e.message; }
    });
  }

  function objectMenu(url, kind, reserved, type, opts) {
    var definable = (kind === 'container' || kind === 'object' || kind === 'queue') && !reserved;
    var importable = (kind === 'container' || kind === 'queue') && !reserved;      // a data object has no imports
    var label = (function () { var d = diskFor(url); return d ? d.name + ':' + pathIn(d, url) : url; })();
    var isC = kind === 'container' && !reserved;
    // Whether a data object is version-enabled is in its metadata, which a listing does not carry, so the versioning
    // entry (below, in the CDMI submenu) settles once the menu is up. Held here so its action and later share it.
    var versioned = false;
    return [
      { label: 'CDMI', submenu: function () { return [
        { label: 'Define tags\u2026', disabled: !definable, action: function () { tagsWindow(url, kind); } },
        { label: 'Define exports\u2026', disabled: !definable, action: function () { defineWindow(url, 'exports', type ? kind : null); } },
        { label: 'Define imports\u2026', disabled: !importable, action: function () { defineWindow(url, 'imports', type ? kind : null); } },
        { label: 'Define ACL\u2026', disabled: !definable, action: function () { defineAclWindow(url, kind); } },
        { label: 'Define DAC\u2026', disabled: !definable || !dacSupported(), action: function () { defineDacWindow(url); } },
        { label: 'Define retention\u2026', disabled: true, action: function () { defineRetentionWindow(url); },
          later: function (settle) { if (!definable) return settle(null, false); objectCaps(url).then(function (caps) { settle(null, retentionInCaps(caps)); }, function () { settle(null, false); }); } },
        { label: 'Define encryption\u2026', disabled: true, action: function () { defineEncryptionWindow(url); },
          later: function (settle) { if (kind !== 'object') return settle(null, false); objectCaps(url).then(function (caps) { settle(null, caps.cdmi_encryption === 'true' && capOn('cdmi_enc_inplace')); }, function () { settle(null, false); }); } },
        { label: 'Define signing\u2026', disabled: true, action: function () { defineSigningWindow(url); },
          later: function (settle) { if (kind !== 'object') return settle(null, false); objectCaps(url).then(function (caps) { settle(null, caps.cdmi_enc_object_sign_id === 'true' || caps.cdmi_enc_value_sign_id === 'true'); }, function () { settle(null, false); }); } },
        { label: 'Verify signature\u2026', disabled: true, action: function () { verifySignatureWindow(url); },
          later: function (settle) { if (kind !== 'object') return settle(null, false); getLeaf(url + '?metadata=cdmi_enc_signature', { quiet: true }).then(function (g) { settle(null, !!(g.rep && g.rep.metadata && g.rep.metadata.cdmi_enc_signature)); }, function () { settle(null, false); }); } },
        { label: 'Storage goals\u2026', disabled: true, action: function () { defineStorageGoalsWindow(url); },
          later: function (settle) { if (!definable) return settle(null, false); objectCaps(url).then(function (caps) { settle(null, STORAGE_GOALS.some(function (f) { return caps[f.n] === 'true'; })); }, function () { settle(null, false); }); } },
        { label: 'Enable versioning\u2026', disabled: true,
          action: function () { if (versioned) versionsWindow(url); else enableVersioning(url, label); },
          later: function (settle) {
            if (kind !== 'object' || reserved) return settle(null, false);
            getLeaf(url + '?objectType&metadata=cdmi_version', { quiet: true }).then(function (got) {
              var md = got.rep.metadata || {}; versioned = !!(md.cdmi_version_current || (md.cdmi_version_oldest || []).length);
              if (got.rep.objectType === T_QUEUE) return settle('Show versions\u2026', false);
              settle(versioned ? 'Show versions\u2026' : 'Enable versioning\u2026', true);
            }, function () { settle(null, false); });
          } },
        '-',
        { label: 'Create snapshot\u2026', disabled: !isC, action: function () { createSnapshot(url, label); } },
        { label: 'View snapshots', disabled: !isC, action: function () { openContainer(url + 'cdmi_snapshots/', { browse: true }); } },
        '-',
        { label: 'Serialize\u2026', disabled: !definable, action: function () { serializeContainer(url, label); } },
        { label: 'Deserialize here\u2026', disabled: !isC, action: function () { deserializeHere(url, label); } }
      ]; } }
    ].concat(definable && !(opts && opts.omitDelete) ? ['-', { label: 'Delete…', action: function () { deleteObject(url, kind, label); } }] : []);
  }

  /* Create a new, empty container within the one a browser is showing. The name is asked for; a PUT with
     If-None-Match: * makes it, and refuses where the name is taken. */
  function newNamedContainer(browser) {
    if (!browser.url || !browser.isContainer) return;
    var loc = browser.disk ? browser.disk.name + ':' + pathIn(browser.disk, browser.url) : browser.url, n = ++uid;
    // Name, then domain, owner and access control list -- the same three, in the same order, as the ACL inspector and
    // the by-object-ID create. Owner and domain are sent only when given, so a plain create carries neither.
    var name = field('fvcn' + n, 'Name', ''); name.input.placeholder = 'container name';
    var domain = field('fvcd' + n, 'Domain', ''); domain.input.placeholder = 'domainURI (blank = the parent’s domain)';
    var owner = field('fvco' + n, 'Owner', ''); owner.input.placeholder = 'principal (blank = you); required for another domain';
    var acl = aclBuilder(null, { forDir: true });
    var status = h('p', {});
    var cancel = h('button', { class: 'fv-btn', type: 'button', text: 'Cancel' });
    var ok = h('button', { class: 'fv-btn', type: 'button', text: 'Create' });
    var w = new Win({ title: 'New container · ' + loc, w: 640, h: 600, center: true, escCloses: true,
      content: h('div', { class: 'fv-form' }, [
        h('p', { text: 'Create an empty container inside ' + loc + '. Optionally set its domain, owner and access control list.' }),
        name.row,
        domain.row,
        owner.row,
        h('h6', { text: 'Access control list' }),
        acl.el,
        status,
        h('div', { class: 'fv-row end' }, [cancel, h('span', { style: 'flex:1' }), ok]) ]) });
    cancel.addEventListener('click', function () { w.close(); });
    async function submit() {
      var nm = name.input.value.trim();
      if (!nm) { status.textContent = 'Type a name.'; return; }
      if (/[\/?]/.test(nm)) { status.textContent = 'A name holds no "/" or "?".'; return; }
      var dest = browser.url + enc(nm) + '/', body = { metadata: {} };
      var aclv = acl.value(); if (aclv) body.metadata.cdmi_acl = aclv;
      var ov = owner.input.value.trim(); if (ov) body.metadata.cdmi_owner = ov;
      var dv = domain.input.value.trim(); if (dv) body.domainURI = dv;
      status.textContent = 'Creating the container …';
      try {
        var res = await send('PUT', dest, T_CONTAINER, JSON.stringify(body), { 'If-None-Match': '*' });
        if (res.status === 412 || res.status === 409) { status.textContent = 'A child named ' + nm + ' is already there.'; return; }
        if (!res.ok) throw await toError(res);
        delete appCache[browser.url]; delete expImpCache[stripQuery(browser.url)];
        browsers.forEach(function (b) { if (!b.win.closed && b.url === browser.url) b.show(b.url); });
        w.close();
      } catch (e) { status.textContent = 'Not created: ' + (e && e.message || e); }
    }
    ok.addEventListener('click', submit);
    // Enter creates only from the single-line fields, not from within the ACL editor's own inputs.
    [name.input, domain.input, owner.input].forEach(function (inp) { inp.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') submit(); }); });
    name.input.focus();
  }

  /* Rename a child by moving it to a new name within the same container: a create carrying a "move" field, as a
     drag-move does. The name is checked first, since a server need not honour If-None-Match on a move. */
  async function renameObject(browser, url, c, newBase) {
    var parent = browser.url, isC = c.kind === 'container';
    newBase = newBase.replace(/[\/?]$/, '');
    if (!newBase || newBase === c.name.replace(/[\/?]$/, '')) { browser.show(browser.url); return; }
    if (/[\/?]/.test(newBase)) { messageBox('Cannot rename', 'A name holds no "/" or "?".'); browser.show(browser.url); return; }
    var type = isC ? T_CONTAINER : c.kind === 'queue' ? T_QUEUE : T_OBJECT, dest = parent + enc(newBase) + (isC ? '/' : '');
    try {
      var there = await req(dest + '?objectName', type, { quiet: true });
      if (there.ok) { messageBox('Cannot rename', (isC ? 'A container' : 'An object') + ' named ' + newBase + ' is already there.'); browser.show(browser.url); return; }
      var body = { move: url };   // the absolute source URI; a "~/" shorthand path is not one the server accepts
      var res = await send('PUT', dest, type, JSON.stringify(body));
      if (!res.ok) throw await toError(res);
      [parent, url].forEach(function (u) { delete appCache[u]; delete iconCache[u]; delete iconKnown[u]; delete expImpCache[u]; delete expImpCache[stripQuery(u)]; });
      browsers.forEach(function (b) { if (!b.win.closed && b.url === parent) b.show(b.url); });
    } catch (e) { messageBox('Cannot rename', e.message); browser.show(browser.url); }
  }

  /* Ask for a new name and rename the child. promptBox refuses an empty name and one holding "/" or "?". */
  async function renameDialog(browser, url, c) {
    var old = c.name.replace(/[\/?]$/, '');
    var name = await promptBox('Rename', 'Rename ' + old + ' within this container.', 'New name', old, 'Rename');
    if (name && name !== old) renameObject(browser, url, c, name);
  }

  Browser.prototype.render = function (list) {
    var self = this, atRoot = this.disk && this.url === this.disk.base, probes = [], asList = this.view === 'list', px = asList ? 16 : 40;
    this.listing = list;
    // The container being shown carries its own exports/imports in the listing (added to the field selector), so it
    // does not need a probe. Seed the cache with it so a later visit as a child does not read it again.
    var selfInfo = definedExpImp(list.rep), selfBadge = badgeFor(selfInfo);
    expImpCache[stripQuery(this.url)] = selfInfo;
    this.grid.textContent = ''; this.grid.scrollTop = 0;
    if (!list.children.length) this.note('This container is empty.');
    var children = list.children;
    if (asList && children.length) {
      var COLS = [['name', 'Name'], ['kind', 'Type'], ['modified', 'Last modified'], ['size', 'Size']];
      this.grid.appendChild(h('div', { class: 'fv-lhead', role: 'row' }, COLS.map(function (col) {
        var mark = self.sort && self.sort.key === col[0] ? (self.sort.dir > 0 ? ' \u25B4' : ' \u25BE') : '';
        var b = h('button', { type: 'button', class: col[0] === 'size' ? 'num' : '', title: 'Sort by ' + col[1].toLowerCase(), text: col[1] + mark });
        b.addEventListener('click', function () { self.sort = { key: col[0], dir: self.sort && self.sort.key === col[0] ? -self.sort.dir : 1 }; self.render(list); });
        return b;
      })));
      if (this.sort) {
        var key = this.sort.key, dir = this.sort.dir;
        children = children.slice().sort(function (a, b) {
          var x = key === 'kind' ? typeLabel(a) : a[key], y = key === 'kind' ? typeLabel(b) : b[key];
          if (x === null || x === undefined) return y === null || y === undefined ? 0 : 1;        // what is unknown goes last either way
          if (y === null || y === undefined) return -1;
          return (typeof x === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: 'base' })) * dir;
        });
      }
    }
    if (asList && this.isContainer) {               // the container itself, and the one above it
      var md = list.rep.metadata || {}, parent = atRoot || !this.disk ? null : this.url.replace(/[^\/]+\/$/, '');
      [['.', this.url, md.cdmi_mtime || null, 'This container'], ['..', parent, null, 'The container above']].forEach(function (dot) {
        if (!dot[1]) return;
        var dotNm = h('span', { class: 'fv-nm' }, [h('span', { class: 'fv-tw leaf' }), h('i', { html: icon('container', 16), style: 'display:flex' }), h('span', { class: 'fv-name', text: dot[0] })]);
        var row = h('div', { class: 'fv-item', role: 'button', tabindex: '0', title: dot[3] }, [dotNm,
          h('span', { class: 'dim', text: 'Container' }), h('span', { class: 'dim', text: whenLabel(dot[2]), title: dot[2] || '' }), h('span', { class: 'dim num', text: '\u2014' })]);
        function go() { if (dot[0] === '.') self.show(self.url); else self.show(dot[1]); }
        row.addEventListener('click', function () { self.select(row); self.status.textContent = dot[3] + ' \u00B7 ' + (self.disk ? self.disk.name + ':' + pathIn(self.disk, dot[1]) : dot[1]); });
        row.addEventListener('dblclick', go); row.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); go(); } });
        row.addEventListener('contextmenu', function (ev) { ev.preventDefault(); self.select(row); popupMenu(ev.clientX, ev.clientY, dot[0], [{ label: 'Open', action: go }, '-'].concat(objectMenu(dot[1], 'container', false), ['-', { label: 'Get info', action: function () { infoWindow(dot[1]); } }])); });
        if (dot[0] === '..') acceptDrops(row, function () { return dot[1]; }, function (t) { self.status.textContent = t; });        // dropping on ".." moves up a level
        self.grid.appendChild(row);
      });
    }
    /* Run queued per-child probes (icon, badge, time/size), a few at a time. */
    function pump(arr, n) { for (var i = 0; i < (n || 4); i++) (function next() { var job = arr.shift(); if (job) job().then(next, next); })(); }

    /* In list view a container row carries a disclosure triangle: expanding it reads that container and inserts its
       children below, indented one level deeper; collapsing removes them. Expansion is live and resets on re-render. */
    async function toggleExpand(item, url, depth, tw) {
      if (item._expanded) {
        var n = item.nextSibling;
        while (n && n.dataset && n.dataset.depth !== undefined && +n.dataset.depth > depth) { var nx = n.nextSibling; n.remove(); n = nx; }
        item._expanded = false; tw.textContent = '▸'; return;
      }
      item._expanded = true; tw.textContent = '▾'; tw.classList.add('busy');
      try {
        var d = diskFor(url), sub = await listContainer(url, d ? d.base : url, true), sink = [], after = item;
        (sub.children || []).forEach(function (cc) { var row = buildRow(cc, url, depth + 1, sink); after.after(row); after = row; });
        tw.classList.remove('busy'); pump(sink);
      } catch (e) { item._expanded = false; tw.textContent = '▸'; tw.classList.remove('busy'); self.status.textContent = 'Could not expand — ' + (e && e.message || e); }
    }

    /* Build one row for child c of container parentURL, at tree depth (0 for a direct child). Per-child probes queue
       in sink; the caller places the returned row in the grid. */
    function buildRow(c, parentURL, depth, sink) {
      var bare = c.name.replace(/[\/?]$/, ''), url = childURL(parentURL, c.name);
      var atRootHere = self.disk && parentURL === self.disk.base;
      var sys = c.kind === 'container' && /^cdmi_/.test(bare) && (atRootHere || bare === 'cdmi_snapshots');
      var ic = c.kind === 'container' ? (sys ? 'system' : 'container') : c.kind === 'reference' ? 'reference' : c.kind === 'queue' ? 'queue'
        : /\.pdf$/i.test(bare) ? 'pdf' : /\.(m?js|json|sh|py|css|html?)$/i.test(bare) ? 'script' : /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(bare) ? 'image' : 'object';
      var pic = h('i', { html: icon(ic, px), style: 'display:flex' }), picWrap = h('span', { class: 'fv-pic' }, [pic]), kindCell = asList ? h('span', { class: 'dim', text: typeLabel(c) }) : null;
      var nameEl = h('span', { class: 'fv-name', text: c.name });
      var modCell = asList ? h('span', { class: 'dim', text: whenLabel(c.modified), title: c.modified || '' }) : null;
      var sizeCell = asList ? h('span', { class: 'dim num', text: sizeLabel(c.size), title: c.size === null ? '' : c.size + ' bytes' }) : null;
      var expandable = asList && c.kind === 'container';
      var tw = asList ? h('span', { class: 'fv-tw' + (expandable ? '' : ' leaf'), 'aria-hidden': 'true', text: expandable ? '▸' : '' }) : null;
      var nameWrap = asList ? h('span', { class: 'fv-nm', style: depth ? 'padding-left:' + (depth * 18) + 'px' : null }, [tw, picWrap, nameEl]) : null;
      var item = h('div', { class: 'fv-item' + (sys ? ' sys' : ''), role: 'button', tabindex: '0', title: c.name + (c.type ? '  (' + c.type + ')' : '') }, asList
        ? [nameWrap, kindCell, modCell, sizeCell]
        : [picWrap, nameEl]);
      item.dataset.depth = String(depth);
      if (expandable) tw.addEventListener('click', function (ev) { ev.stopPropagation(); ev.preventDefault(); toggleExpand(item, url, depth, tw); });
      // The list view needs each child's time and size. A listing that is not detailed does not carry them (a server
      // that does not offer the extended child listing, or the snapshot listings, which return names alone), so each
      // child is read once to fill the two columns. Detailed listings already have them and are not probed.
      if (asList && !c.detailed && c.kind !== 'reference' && sink.length < CFG.probeLimit) sink.push(function () {
        return getRep(url + '?objectType&mimetype&metadata=cdmi_mtime&metadata=cdmi_size', c.kind === 'container' ? T_CONTAINER : ACCEPT_LEAF, { quiet: true }).then(function (g) {
          var md = (g.rep && g.rep.metadata) || {};
          if (md.cdmi_mtime) { modCell.textContent = whenLabel(String(md.cdmi_mtime)); modCell.title = String(md.cdmi_mtime); }
          if (md.cdmi_size !== undefined && md.cdmi_size !== null && isFinite(+md.cdmi_size)) { sizeCell.textContent = sizeLabel(+md.cdmi_size); sizeCell.title = md.cdmi_size + ' bytes'; }
          if (kindCell && g.rep.mimetype && c.kind !== 'container') kindCell.textContent = g.rep.mimetype;
        }, function () { /* leave the dash */ });
      });
      var isApp = false, expImp = null;      // whether this child defines exports/imports, once known
      function markExpImp(info) {
        expImp = info; var b = badgeFor(info); if (!b || picWrap.querySelector('.fv-badge')) return;
        picWrap.appendChild(h('span', { class: 'fv-badge ' + b.cls, html: arrowSvg(b.cls), title: b.tip }));
        item.title = c.name + (c.type ? '  (' + c.type + ')' : '') + '  · ' + b.tip;
      }
      function markLock(r) {
        var b = lockBadgeFor(r); if (!b || picWrap.querySelector('.fv-lock')) return;
        picWrap.appendChild(h('span', { class: 'fv-lock' + (b.cls ? ' ' + b.cls : ''), html: lockSvg(), title: b.tip }));
      }
      function becomeApp() {
        isApp = true; pic.innerHTML = icon('app', px); if (kindCell) kindCell.textContent = 'Application';
        loadIcon(url).then(function (src) { if (src && pic.isConnected) { pic.textContent = ''; pic.appendChild(iconImg(src, px)); } });
      }
      function open(browse) {
        if (c.kind === 'container') openContainer(url, { into: self, browse: browse });
        else openObject(url, c.name, self);     // a reference is followed by fetch(); openObject looks at what it led to
      }
      item.addEventListener('click', function () { var b = badgeFor(expImp); self.select(item); self.status.textContent = c.name + (c.type ? ' \u00B7 ' + c.type : c.kind === 'reference' ? ' \u00B7 reference' : '') + (isApp ? ' \u00B7 contains ' + CFG.appEntry + ' \u2014 double-click to run' : '') + (b ? ' \u00B7 ' + b.tip : ''); });
      item.addEventListener('dblclick', function () { open(false); });
      item.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') { ev.preventDefault(); open(false); }
        else if ((ev.key === 'Delete' || ev.key === 'Backspace') && !sys && c.kind !== 'reference') { ev.preventDefault(); deleteObject(url, c.kind, c.name); }
      });
      item.addEventListener('contextmenu', function (ev) {
        ev.preventDefault(); self.select(item);
        var mkind = (c.type === T_CAPABILITY || c.type === T_DOMAIN) ? 'other' : c.kind;
        popupMenu(ev.clientX, ev.clientY, c.name, [
          { label: isApp ? 'Run' : 'Open', action: function () { open(false); } },
          { label: 'Open in mdviewer', disabled: !helpers.mdviewer || c.kind !== 'object' || !(/\.(md|markdown|mdown|mkd)$/i.test(stripQuery(url))), action: function () { launchApp(helpers.mdviewer, { start: url }); } },
          { label: 'Open in pdfviewer', disabled: !helpers.pdfviewer || c.kind !== 'object' || !(/\.pdf$/i.test(stripQuery(url))), action: function () { launchApp(helpers.pdfviewer, { start: url }); } },
          { label: 'Open in Textile', disabled: !helpers.textile || c.kind !== 'object', action: function () { launchApp(helpers.textile, { start: url }); } },
          { label: 'View', disabled: c.kind === 'container', action: function () { openObject(url, c.name, self, false, true); } },
          { label: 'Browse contents', disabled: c.kind !== 'container', action: function () { open(true); } },
          { label: 'Open in new window', disabled: c.kind !== 'container', action: function () { openContainer(url, { browse: true }); } },
          { label: 'Open in xterm', disabled: c.kind !== 'container' || !findXterm(), action: function () { launchXterm(url); } },
          { label: 'Rename…', disabled: sys || isReserved(c.name, parentURL) || c.kind === 'reference', action: function () { renameDialog(self, url, c); } },
          { label: 'Delete…', disabled: sys || !(mkind === 'container' || mkind === 'object' || mkind === 'queue'), action: function () { deleteObject(url, c.kind, c.name); } },
          '-'].concat(objectMenu(url, mkind, sys, c.type, { omitDelete: true }), ['-', { label: 'Get info', disabled: c.kind === 'reference', action: function () { infoWindow(url); } }]));
      });
      if (!isReserved(c.name, parentURL)) {                // reserved containers stay where they are
        item.draggable = true;
        item.addEventListener('dragstart', function (ev) {
          dragging = { url: url, name: c.name, kind: c.kind, type: c.type, parent: parentURL };
          ev.dataTransfer.setData(DRAG_TYPE, JSON.stringify(dragging)); ev.dataTransfer.effectAllowed = 'copyMove';
          item.classList.add('fv-lifted'); root.classList.add('fv-dragging'); closeMenus();
        });
        item.addEventListener('dragend', function () { dragging = null; item.classList.remove('fv-lifted'); root.classList.remove('fv-dragging'); document.querySelectorAll('.fv-into,.fv-over,.fv-open').forEach(function (n) { n.classList.remove('fv-into', 'fv-over', 'fv-open'); }); });
      }
      if (c.kind === 'container' && !sys) {
        // A plain container receives dropped objects (move/copy in). An APPLICATION (a container with index.js) instead
        // OPENS a dropped object: the app is run with that object as its start, and the app itself handles an object it
        // cannot open -- which it must do for any open anyway. So move-into is disabled once it is known to be an app.
        acceptDrops(item, function () { return (isApp || (dragging && dragging.url === url)) ? null : url; }, function (t) { self.status.textContent = t; });
        acceptAppOpen(item, function () { return isApp ? url : null; }, function (t) { self.status.textContent = t; });
        if (c.inside) {                                   // the extended listing already said what this child holds
          appCache[url] = c.inside.indexOf(CFG.appEntry) >= 0; iconKnown[url] = c.inside.indexOf(CFG.appIcon) >= 0;
          if (appCache[url]) becomeApp();
        } else if (sink.length < CFG.probeLimit) sink.push(function () { return probeApp(url).then(function (yes) { if (yes) becomeApp(); }); });
        // The exports/imports fields are not carried by a listing, so each container child is read once to find whether it
        // defines either. The badge is shown in icon view only; the list view does not carry it.
        if (!asList && sink.length < CFG.probeLimit) sink.push(function () { return probeExpImp(url).then(markExpImp); });
      }
      // Lock overlay: an object under retention or hold. A detailed listing already carries the metadata (list view,
      // no extra request); an icon-view listing does not, so each child is read once, bounded like the other probes.
      if (c.kind !== 'reference' && !sys) {
        if (c.locked) { if (c.locked.restricted) markLock(c.locked); }
        // A detailed listing carries each child's lock state (c.locked is the state, or null when unrestricted), so it
        // is trusted and not probed. Only a plain (non-detailed) listing's children are read one at a time.
        else if (!c.detailed && sink.length < CFG.probeLimit) sink.push(function () { return probeLock(url).then(function (r) { if (r && r.restricted) markLock(r); }); });
      }
      return item;
    }

    children.forEach(function (c) { self.grid.appendChild(buildRow(c, self.url, 0, probes)); });
    var range = list.rep.childrenrange;
    this.baseStatus = list.children.length + (list.children.length === 1 ? ' child' : ' children') + (range ? ' \u00B7 childrenrange ' + range : '') +
      (list.truncated ? ' \u00B7 listing stopped at ' + CFG.maxChildren : '') + (list.rep.objectType && list.rep.objectType !== T_CONTAINER ? ' \u00B7 ' + list.rep.objectType : '') +
      (selfBadge ? ' \u00B7 ' + selfBadge.tip : '');
    this.status.textContent = this.baseStatus;
    pump(probes);
  };


  /* ------------------------------------------------------------------ screen capture (for the capture app)

     Only the top-level desktop page can turn the rendered desktop -- its window chrome and the app iframes alike --
     into pixels, and the only API a browser offers for that is getDisplayMedia (an in-DOM rasterisation cannot reach
     iframe content). So the capture lives here, and the capture application is a thin UI that calls it. The browser
     shows its own "share this tab" prompt; preferCurrentTab asks for this tab so the frame maps to the viewport. */
  async function grabTabFrame() {
    if (!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia)) throw new Error('This browser does not offer screen capture.');
    // Ask for THIS tab's surface only: a tab capture contains just the page, so the browser's share picker and its
    // "you are sharing" indicator -- which belong to the browser/OS, not the page -- are never in the frame. (If the
    // user overrides and picks Entire screen or a window, that OS chrome can appear; capturing the tab avoids it.)
    var stream = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: 'browser' }, audio: false,
      preferCurrentTab: true, selfBrowserSurface: 'include', surfaceSwitching: 'exclude', monitorTypeSurfaces: 'exclude'
    });
    try {
      var track = stream.getVideoTracks()[0], set = (track.getSettings && track.getSettings()) || {};
      var video = document.createElement('video'); video.muted = true; video.playsInline = true; video.srcObject = stream;
      try { await video.play(); } catch (e) { /* autoplay of a muted stream is allowed; ignore a spurious reject */ }
      await new Promise(function (res) { if (video.videoWidth) return res(); video.onloadedmetadata = res; setTimeout(res, 600); });
      // Settle before the grab: let the share picker finish dismissing and any transient browser chrome clear, then take
      // a current frame (the stream keeps playing), so none of that share UI lands in the picture.
      await new Promise(function (res) { setTimeout(res, 450); });
      await new Promise(function (res) { requestAnimationFrame(function () { requestAnimationFrame(res); }); });
      var fw = video.videoWidth || set.width || window.innerWidth, fh = video.videoHeight || set.height || window.innerHeight;
      var c = h('canvas'); c.width = fw; c.height = fh;
      c.getContext('2d').drawImage(video, 0, 0, fw, fh);
      return { canvas: c, fw: fw, fh: fh };
    } finally { stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} }); }
  }
  // Let the user drag a rectangle over the desktop; resolves {x,y,w,h} in client coords, or null if cancelled.
  function selectRegion() {
    return new Promise(function (resolve) {
      var ov = h('div', { class: 'fv-capsel' }), box = h('div', { class: 'fv-capbox' });
      ov.appendChild(box); document.body.appendChild(ov);
      var sx = 0, sy = 0, dragging = false;
      function done(rect) { document.removeEventListener('keydown', key); ov.remove(); resolve(rect); }
      function key(e) { if (e.key === 'Escape') { e.preventDefault(); done(null); } }
      ov.addEventListener('pointerdown', function (e) { dragging = true; sx = e.clientX; sy = e.clientY; box.style.display = 'block'; box.style.left = sx + 'px'; box.style.top = sy + 'px'; box.style.width = '0'; box.style.height = '0'; try { ov.setPointerCapture(e.pointerId); } catch (x) {} e.preventDefault(); });
      ov.addEventListener('pointermove', function (e) { if (!dragging) return; var x = Math.min(sx, e.clientX), y = Math.min(sy, e.clientY), w = Math.abs(e.clientX - sx), ht = Math.abs(e.clientY - sy); box.style.left = x + 'px'; box.style.top = y + 'px'; box.style.width = w + 'px'; box.style.height = ht + 'px'; });
      function up(e) { if (!dragging) return; dragging = false; var x = Math.min(sx, e.clientX), y = Math.min(sy, e.clientY), w = Math.abs(e.clientX - sx), ht = Math.abs(e.clientY - sy); done(w >= 4 && ht >= 4 ? { x: x, y: y, w: w, h: ht } : null); }
      ov.addEventListener('pointerup', up); ov.addEventListener('pointercancel', function () { done(null); });
      document.addEventListener('keydown', key);
    });
  }
  // A window by its stable id (any Win -- a dialog, a container viewer, an app), falling back to an app id.
  function winById(id) {
    for (var i = 0; i < WM.wins.length; i++) if (WM.wins[i].wid === id) return WM.wins[i];
    return (id && apps[id]) || null;
  }
  // The capture targets: every open, non-iconified window (dialogs and viewers included, not only app iframes), minus
  // the window of the app that is asking (so the capture app does not list itself). Each carries its stable id.
  function captureTargets(excludeAppId) {
    var mine = excludeAppId && apps[excludeAppId] ? apps[excludeAppId] : null;
    return WM.wins.filter(function (w) { return w !== mine && !w.iconified; })
      .map(function (w) { return { id: w.wid, title: w.title }; });
  }
  // The one entry point the capture app calls. mode is 'screen', 'window' (opts.winId) or 'rect'. It grabs the tab
  // frame FIRST -- on the user gesture that reached this call -- so getDisplayMedia always has activation; a region is
  // then chosen from the already-captured frame. For 'window' the target is raised to the front for the shot (so
  // nothing overlaps it) and put back to its previous stacking position after. Returns a PNG data URL, or null if the
  // region select was cancelled.
  async function capturePng(opts) {
    opts = opts || {};
    var win = opts.mode === 'window' ? winById(opts.winId) : null, raised = null;
    if (win && win.el) {
      var r0 = win.el.getBoundingClientRect(); opts.rect = { x: r0.left, y: r0.top, w: r0.width, h: r0.height };
      raised = { el: win.el, z: win.el.style.zIndex }; win.el.style.zIndex = ++WM.z;   // bring to front for the shot
    }
    var rect = opts.rect || null;
    var hideEl = opts.hideId && apps[opts.hideId] ? apps[opts.hideId].el : null, prev = null;
    if (hideEl) { prev = hideEl.style.visibility; hideEl.style.visibility = 'hidden'; }
    var g;
    try { g = await grabTabFrame(); }
    finally { if (hideEl) hideEl.style.visibility = prev || ''; if (raised) raised.el.style.zIndex = raised.z; }   // restore the window's layer
    if (opts.mode === 'rect') { rect = await selectRegion(); if (!rect) return null; }   // cancelled
    var sx = g.fw / window.innerWidth, sy = g.fh / window.innerHeight, r = rect;
    var rx = r ? clamp(Math.round(r.x * sx), 0, g.fw - 1) : 0, ry = r ? clamp(Math.round(r.y * sy), 0, g.fh - 1) : 0;
    var rw = r ? clamp(Math.round(r.w * sx), 1, g.fw - rx) : g.fw, rh = r ? clamp(Math.round(r.h * sy), 1, g.fh - ry) : g.fh;
    var out = h('canvas'); out.width = rw; out.height = rh;
    out.getContext('2d').drawImage(g.canvas, rx, ry, rw, rh, 0, 0, rw, rh);
    return out.toDataURL('image/png');
  }

  /* ------------------------------------------------------------------ public surface and boot */

  var API = window.cvwm = {
    userinfo: function () { return CD.userinfo || null; },
    version: VERSION, config: CFG,
    open: function (url) { return /\/$/.test(stripQuery(url)) ? openContainer(url) : openObject(url); },
    browse: function (url) {                                    // open a web page in Earthworm (a link from an app)
      if (!/^https?:/i.test(url)) return false;
      if (helpers.earthworm) { launchApp(helpers.earthworm, { start: url }); return true; }
      try { window.open(url, '_blank', 'noopener'); } catch (e) { /* popup blocked */ }
      return false;
    },
    /* Start the application in a container as a command: process = { argv, cwd, stdout(text), stderr(text), shell, start, onExit(code) }. */
    launch: function (containerURL, process) { return launchApp(containerURL, { process: process, start: (process && process.start) || null }); },
    rescan: function () { return rescan(); },
    reload: function (url) { var u = stripQuery(url); browsers.forEach(function (b) { if (!b.win.closed && (b.url === u || b.url + '/' === u || b.url === u + '/')) b.show(b.url); }); },
    fetchBytes: async function (url) {                              // for apps that need raw bytes of a resource (e.g. the framer's favicon)
      try {
        if (!/^https?:\/\//i.test(url)) return null;
        // A favicon or similar is a real external resource, not a CDMI object, so use the browser's fetch directly.
        var res = await fetch(url, { credentials: 'omit', redirect: 'follow' });
        if (!res.ok) return null;
        var buf = await res.arrayBuffer(); if (!buf.byteLength || buf.byteLength > 262144) return null;
        var b = new Uint8Array(buf), str = ''; for (var i = 0; i < b.length; i += 0x8000) str += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
        return { mime: (res.headers.get('content-type') || '').split(';')[0] || 'application/octet-stream', base64: btoa(str) };
      } catch (e) { return null; }
    },
    loadRsrc: function (forkURL) { return loadRsrcFork(forkURL); },   // an app's resource fork, parsed and cached (rsrc/)
    home: function () { var d = homeDisk(); return d ? d.base : null; },
    mount: function (base, name) {                              // mount a namespace base URI as a disk (namespaces, servers, connect dialog)
      base = stripQuery(String(base || '')); if (!/\/$/.test(base)) base += '/';
      if (!/^https:/i.test(base)) return false;
      var cross = !sameOrigin(base);
      addMount({ name: (name && String(name).trim()) || 'cloud', base: base, manual: true, crossOrigin: cross });
      // A cross-origin base is vouched with a CORS preflight (spec 302 s6); once it answers, the credential may flow
      // to it (req/send). The disk is already shown; the vouch resolves in the background and redraws.
      if (cross && !vouchedOrigins[originOf(base)]) vouchedOrigin(base).then(function () { drawDisks(); });
      return true;
    },
    unmount: function (base) {                                  // remove a manually-mounted disk
      base = stripQuery(String(base || '')); if (!/\/$/.test(base)) base += '/';
      var i = disks.findIndex(function (d) { return d.base === base && d.manual; });
      if (i < 0) return false; disks.splice(i, 1); saveManual(); drawDisks(); return true;
    },
    mounted: function () { return disks.map(function (d) { return { name: d.name, base: d.base, home: !!d.home, manual: !!d.manual, locked: !!d.locked, crossOrigin: !!d.crossOrigin }; }); },
    mcpEndpoint: function () {                                  // the CDMI over MCP endpoint URI the server advertises (cdmi_mcp_uri), or null
      var uri = CD.caps && CD.caps.cdmi_mcp_uri;
      return typeof uri === 'string' && uri ? uri : null;
    },
    async domainInfo(url) {                                     // one domain object: its representation and child domains
      url = stripQuery(String(url || '')); if (!/\/$/.test(url)) url += '/';
      if (!/^https:\/\//i.test(url)) throw new Error('a domain URL is an https: URL');
      var got = await getRep(url, T_DOMAIN, { quiet: true });
      var rep = got.rep || {};
      // Child domains are the container-like children (names ending in "/") that are not reserved (cdmi_*).
      var kids = normChildren(rep.children, false).map(function (c) { return c.name; })
        .filter(function (nm) { return /\/$/.test(nm) && !/^cdmi_/.test(nm.replace(/\/$/, '')); })
        .map(function (nm) { return { name: nm.replace(/\/$/, ''), url: url + enc(nm.replace(/\/$/, '')) + '/' }; });
      return { url: stripQuery(got.url || url), rep: rep, children: kids };
    },
    userinfo: function () {                                     // the signed-in principal (identifier, groups, privileges), or null
      if (!CD.userinfo && !CD.auth) return null;
      return Object.assign({ authenticated: !!CD.auth }, CD.userinfo || {});
    },
    /* Whether the signed-in principal may create a sub-domain under this domain: reads the domain's ACL
       (cdmi_acl) and evaluates the ADD_SUBCONTAINER bit, and consults the domain's own capabilities for
       cdmi_create_domain. Pass the already-read representation as `rep` to avoid a re-read. The server is the
       final arbiter; this only decides whether the desktop offers the action. Returns
       { allowed, decision, capable, hasAcl, reason }. */
    async domainCreatePermission(url, rep) {
      url = stripQuery(String(url || '')); if (!/\/$/.test(url)) url += '/';
      if (!rep) { try { rep = (await getRep(url + '?metadata', T_DOMAIN, { quiet: true })).rep || {}; } catch (e) { rep = {}; } }
      var acl = rep.metadata && rep.metadata.cdmi_acl;
      var decision = aclDecision(acl, ACE_ADD_SUBCONTAINER, principalFor(rep));   // true / false / null
      var capable = null;
      try { var caps = await objectCaps(url); if (caps && 'cdmi_create_domain' in caps) capable = caps.cdmi_create_domain === 'true'; } catch (e) { /* capability unknown */ }
      var allowed = capable !== false && decision !== false;
      var reason = capable === false ? 'This server does not support creating sub-domains here (cdmi_create_domain is off).'
        : decision === false ? 'The domain’s access control list does not grant you permission to add a sub-domain here.'
          : null;
      return { allowed: allowed, decision: decision, capable: capable, hasAcl: Array.isArray(acl) && acl.length > 0, reason: reason };
    },
    /* Create a sub-domain. opts: { enabled:boolean, metadata:object }. If-None-Match:* makes the server refuse
       (412) rather than replace an existing domain. Returns { ok, status, url, error }. */
    async createDomain(parentURL, name, opts) {
      opts = opts || {};
      parentURL = stripQuery(String(parentURL || '')); if (!/\/$/.test(parentURL)) parentURL += '/';
      name = String(name || '').replace(/[\/?#]/g, '').trim();
      if (!name) return { ok: false, status: 0, error: 'A domain needs a name.' };
      var url = parentURL + enc(name) + '/';
      var body = { metadata: Object.assign({}, opts.metadata || {}) };
      if (opts.enabled != null) body.metadata.cdmi_domain_enabled = opts.enabled ? 'true' : 'false';
      try {
        var res = await send('PUT', url, T_DOMAIN, JSON.stringify(body), { 'If-None-Match': '*' });
        if (res.status === 412) return { ok: false, status: 412, error: 'A domain named “' + name + '” already exists here.' };
        if (!res.ok) { var e = await toError(res); return { ok: false, status: res.status, error: e.message }; }
        return { ok: true, status: res.status, url: url };
      } catch (e) { return { ok: false, status: 0, error: (e && e.message) || 'The domain could not be created.' }; }
    },
    domainsRoot: function (origin) {                            // the root domain URL for a server origin
      origin = String(origin || CD.origin || '').replace(/\/+$/, '');
      if (!origin) return null;
      function onOrigin(u) { try { return new URL(u).origin === new URL(origin).origin; } catch (e) { return false; } }
      // Domains live at "<binding base>/cdmi_domains/" -- the server's CDMI binding base (e.g. /cdmi/3.0.0/), NOT a
      // sub-namespace such as a home (whose base is deeper). home_base, from cdmi_domain_userinfo, names that binding
      // base, so prefer it; else a manual mount that is not a home; else fall back to the origin root.
      var base = (CD_home && onOrigin(CD_home.base) && CD_home.base)
        || (disks.filter(function (d) { return !d.home && !d.fromUserinfo && onOrigin(d.base); })[0] || {}).base
        || (origin + '/');
      if (!/\/$/.test(base)) base += '/';
      return base + 'cdmi_domains/';
    },
    async wellKnown(origin) {                                   // the namespaces a server advertises at /.well-known/cdmi/
      origin = String(origin || '').replace(/\/+$/, '');
      if (!/^https:\/\//i.test(origin)) throw new Error('a server origin is an https: URL');
      var treeURL = origin + WELL_KNOWN + 'cdmi_namespaces/';
      function classify(name, base) {
        base = base ? stripQuery(base) : null;
        if (base && !/\/$/.test(base)) base += '/';
        if (!base) return { name: name, base: null, reason: 'the reference does not name a base URI' };
        var abs; try { abs = new URL(base, treeURL).href; } catch (e) { return { name: name, base: null, reason: 'the reference destination is not a URI' }; }
        return { name: name, base: abs, tls: isTLS(abs), sameOrigin: sameOrigin(abs) };
      }
      // One extended listing gives every reference's destination in the `location` field (revision 297), so the
      // base URIs are read without a request per reference (following each 307 can fail cross-origin or on a
      // destination the browser cannot reach, which is the NetworkError seen otherwise).
      var out = [], usedExtended = false;
      try {
        var ex = await req(treeURL + '?childfields=objectName;location', T_CONTAINER, { quiet: true, probe: true });
        if (ex.ok) {
          var rep = await ex.json(), kids = rep.children || [];
          if (kids.length && Array.isArray(kids[0])) {
            usedExtended = true;
            kids.forEach(function (c) {
              var nm = (c[0] || '').replace(/[\/?]$/, ''), loc = c[1];
              if (nm) out.push(classify(nm, typeof loc === 'string' ? loc : null));
            });
          }
        } else if (ex.status === 404) { return { origin: origin, namespaces: [] }; }
      } catch (e) { /* fall through to plain listing + follow */ }
      if (usedExtended) return { origin: origin, namespaces: out };
      // The server did not return the extended listing (older revision): read the names, then follow each
      // reference once, reporting a destination that cannot be reached rather than failing the whole read.
      var res = await req(treeURL, T_CONTAINER, { quiet: true });
      if (res.status === 404) return { origin: origin, namespaces: [] };
      if (!res.ok) throw await toError(res);
      var names = normChildren((await res.json()).children, false);
      for (var i = 0; i < names.length; i++) {
        var name = names[i].name.replace(/[\/?]$/, '');
        var landed = null, followErr = null;
        try {
          var r = await req(treeURL + enc(name), T_CONTAINER, { quiet: true, probe: true });
          landed = stripQuery(r.url || '');
          if (!landed || landed === stripQuery(treeURL + enc(name))) landed = null;
        } catch (e) { followErr = (e && e.message) || 'the reference could not be followed'; }
        if (landed) { out.push(classify(name, landed)); continue; }
        // Following the reference did not land on a base URI (an older server, or a redirect the browser could not
        // follow). Try the conventional base at this origin: a CDMI binding is served at /cdmi/3.0.0/. Probe it, and
        // report it where it answers, so a namespace is still offered instead of a bare error.
        var guess = origin + '/cdmi/3.0.0/';
        try {
          var g = await req(guess, T_CONTAINER, { quiet: true, probe: true });
          if (g.ok || g.status === 401 || g.status === 403) { var c = classify(name, guess); c.locked = g.status === 401 || g.status === 403; c.guessed = true; out.push(c); continue; }
        } catch (e2) { /* the guess did not answer either */ }
        out.push({ name: name, base: null, reason: followErr || 'the reference did not lead to a base URI' });
      }
      return { origin: origin, namespaces: out };
    },
    pickObject: function (opts) { return pickObject(opts || {}); },      // a common Open dialog (FVWM styled)
    dropPane: function (id, handlers) { showDropPane(id, handlers || {}); },   // show a native "open a file" drop pane for an app
    showApp: function (id) { showApp(id); },                                  // swap from the drop pane to the app's iframe
    /* For the console application. */
    log: {
      entries: function () { return LOG.list.slice(); },
      subscribe: function (fn) { LOG.subs.push(fn); return function () { var i = LOG.subs.indexOf(fn); if (i >= 0) LOG.subs.splice(i, 1); }; },
      clear: function () { LOG.list.length = 0; },
      add: function (level, source, text) { return logAdd(level, 'note', source, text); }
    },
    netFor: function (id) { var w = apps[id]; return netFor(w && w.containerURI ? safeDecode(w.containerURI.replace(/\/$/, '').split('/').pop()) : String(id), id); },     // named by its container: "xterm", "ssh"
    capture: function (win, id) { capture(win, function () { return apps[id] ? apps[id].title : id; }, true); },
    /* Screen capture, for the capture app. captureTargets(ownAppId) lists every open window (dialogs and viewers too,
       minus the caller's own) as {id, title}; capturePng({mode:'screen'|'window'|'rect', winId?, hideId?}) returns a PNG
       data URL (or null if a region select was cancelled), raising the window to the front for a 'window' shot. */
    captureTargets: function (ownAppId) { return captureTargets(ownAppId); },
    capturePng: function (opts) { return capturePng(opts || {}); },
    describe: describeValue,
    windows: function () { return [{ id: 'desktop', title: 'Desktop' }].concat(Object.keys(apps).map(function (id) { return { id: id, title: apps[id].title }; })); },
    /* Run code in the desktop's window or in an application's, as if typed into its console. Same-origin is
       what allows it, and it carries the same authority as the application itself. */
    evalIn: async function (id, code) {
      var target = window, label = 'Desktop';
      if (id !== 'desktop') { var w = apps[id]; if (!w) throw new Error('That window has closed.'); target = w.client.querySelector('iframe').contentWindow; label = w.title; }
      logAdd('log', 'eval', label, '> ' + code);
      try {
        var value = (0, target.eval)(code);                       // indirect: global scope of the target window
        if (value && typeof value.then === 'function') value = await value;
        logAdd('log', 'eval', label, '< ' + describeValue(value));
        return value;
      } catch (e) { logAdd('error', 'eval', label, '< ' + describeValue(e), e && e.stack); throw e; }
    },
    app: function (id, what, arg) {              // called by the bootstrap inside each application iframe
      var w = apps[id]; if (!w) return;
      if (what === 'process') return w.process;
      if (what === 'exit') { w.exitCode = arg; w.close(true); }
      else if (what === 'title') w.setTitle(arg); else if (what === 'close') w.close(true); else if (what === 'resize') w.resizeTo(arg[0], arg[1]); else if (what === 'aspect') w.setAspect(arg); else if (what === 'dirty') w.dirty = arg; else if (what === 'open') API.open(new URL(arg, CD.origin + '/').href);
    }
  };

  function boot() {
    document.head.appendChild(h('style', { text: SCROLLBAR_CSS + '\n' + CSS }));
    view = h('div', { class: 'fv-view' }); shield = h('div', { class: 'fv-shield' });
    disksEl = h('div', { class: 'fv-disks', role: 'group', 'aria-label': 'Namespaces' });
    iconsEl = h('div', { class: 'fv-icons', role: 'group', 'aria-label': 'Iconified windows' });
    pagerEl = h('div', { class: 'fv-pager', role: 'group', 'aria-label': 'Pager' });
    root = h('div', { id: 'fv-root' }, [disksEl, view, iconsEl, pagerEl, shield]);       // DOM order is stacking order: windows cover the disks
    document.body.appendChild(root);
    applyTheme(isDark());                                                                // the shared light/dark setting

    function sizeView() { view.style.width = vw() * CFG.desksX + 'px'; view.style.height = vh() * CFG.desksY + 'px'; WM.wins.forEach(function (w) { if (w.maxed) { if (w.aspect) { w.w = vw(); w.h = w.heightForWidth(w.w); if (w.h > vh()) { w.h = vh(); w.w = Math.round((w.h - 36) * w.aspect) + 14; } w.x = Math.round((vw() - w.w) / 2); w.y = Math.round((vh() - w.h) / 2); } else { w.w = vw(); w.h = vh(); } } w.apply(); }); gotoDesk(WM.desk[0], WM.desk[1]); }
    window.addEventListener('resize', sizeView); sizeView();

    root.addEventListener('pointerdown', function (ev) {
      var inMenu = ev.target.closest && ev.target.closest('.fv-menu');
      if (!inMenu) closeMenus();
      if (ev.target !== root && ev.target !== view && ev.target !== disksEl && ev.target !== iconsEl) return;
      disksEl.querySelectorAll('.sel').forEach(function (n) { n.classList.remove('sel'); });
      if (ev.button === 0) rootMenu(ev.clientX, ev.clientY);
      else if (ev.button === 2) popupMenu(ev.clientX, ev.clientY, 'Window List', windowListItems());
    });
    root.addEventListener('contextmenu', function (ev) { if (!(ev.target.closest && ev.target.closest('.fv-text,.fv-in'))) ev.preventDefault(); });
    window.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') closeMenus(); });
    /* While files are dragged over the page, iframes stop taking pointer events so the drag reaches the
       window around them; anywhere that is not a drop target refuses the drop instead of navigating to the file. */
    function dragOff() { root.classList.remove('fv-dragging'); WM.wins.forEach(function (w) { w.el.classList.remove('fv-over'); }); }
    window.addEventListener('dragenter', function (ev) { if (hasFiles(ev)) root.classList.add('fv-dragging'); });
    window.addEventListener('dragover', function (ev) { if (hasFiles(ev) && !ev.fvSeen) { ev.preventDefault(); ev.dataTransfer.dropEffect = 'none'; } });
    window.addEventListener('dragleave', function (ev) { if (!ev.relatedTarget) dragOff(); });
    window.addEventListener('drop', function (ev) { if (hasFiles(ev)) ev.preventDefault(); dragOff(); });
    window.addEventListener('dragend', dragOff);
    window.addEventListener('blur', function () { closeMenus(); });

    // On first open, present a sign-in screen: nothing is mounted for an anonymous client (only a signed-in
    // principal has a home), so the desktop opens straight into the sign-in dialog. Cancelling it proceeds
    // anonymously -- the user can still sign in later from the root menu.
    (async function start() {
      if (isTLS(CD.origin + '/') && !CD.auth) {
        try { await readCapabilities(); } catch (e) { /* the sign-in dialog falls back to offering both methods */ }
        await signInDialog('Sign in to your CDMI desktop.');
      }
      rescan();
    })();
  }

  if (document.body) boot(); else document.addEventListener('DOMContentLoaded', boot);
})();
