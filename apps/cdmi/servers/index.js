/*!
 * servers for cvwm: a Chooser-style browser of CDMI servers on the network, laid out as Miller columns of
 * Domain -> Host -> Namespace, with a Mount action on each namespace. "Domain" here is a DNS-SD browsing domain
 * (a network scope), not a CDMI administrative domain.
 *
 * Discovery is DNS-SD over DNS-over-HTTPS (RFC 8484 wire format). The DoH resolver is read at start from the
 * server's root-domain `cdmi_domain_doh` item (resolver + browse_domains; see CDMI-DOH-DISCOVERY.md) and is shown
 * in an editable, pre-filled field. For a selected domain the app browses `_cdmi._tcp` (PTR -> SRV + TXT) to find
 * hosts; for a selected host it enumerates namespaces from the host's well-known discovery tree via the desktop's
 * wellKnown() bridge; Mount hands the base URI to the desktop's mount().
 */
(function () {
  'use strict';
  var CTX = window.CDMI_CONTEXT || {};
  var D = CTX.desktop || {};
  var HDRS = CTX.headers || {};
  var HOME = (function () { try { return new URL(CTX.baseURI || CTX.origin).origin; } catch (e) { return CTX.origin || ''; } })();
  // Resources: the app's own fork (CTX.rsrc), optional. Absent (a classic install) => every lookup falls back to the
  // built-in default below and the app runs exactly as before. S() reads a string (with an optional {d}-style token),
  // and the stylesheet is pulled from the fork where present further down.
  var R = CTX.rsrc || null;
  function S(id, fb, vars) {
    var v = R && R.text('strings', id); if (v == null) v = fb;
    if (vars) for (var k in vars) v = v.split('{' + k + '}').join(vars[k]);
    return v;
  }

  // ---- style (house tokens shared with relationships/namespaces) -----------------------------------------------------
  var style = document.createElement('style');
  var DEFAULT_CSS =
    ':root{--fg:#1f2328;--muted:#59636e;--bg:#fff;--panel:#f6f8fa;--border:#d1d9e0;--code:#eff1f3;--accent:#0969da;--ok:#1a7f37;--err:#cf222e;--dom:#8250df;--host:#0969da;--ns:#1a7f37;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;}' +
    '@media(prefers-color-scheme:dark){:root:not([data-theme="light"]){--fg:#e6edf3;--muted:#9198a1;--bg:#0d1117;--panel:#151b23;--border:#3d444d;--code:#151b23;--accent:#4493f8;--ok:#3fb950;--err:#f85149;--dom:#c297ff;--host:#4493f8;--ns:#3fb950;}}' +
    'html,body{margin:0;height:100%;background:var(--bg);color:var(--fg);font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;}' +
    'body{display:flex;flex-direction:column;}' +
    '#top{flex:none;display:flex;align-items:center;gap:8px;padding:7px 10px;border-bottom:1px solid var(--border);}' +
    '#top label{font:11px var(--mono);color:var(--muted);flex:none;}' +
    '#top input{flex:1 1 0;min-width:0;height:28px;box-sizing:border-box;font:12px var(--mono);padding:0 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--fg);}' +
    '#top button{height:28px;flex:none;padding:0 12px;border:1px solid var(--border);border-radius:6px;background:var(--code);color:var(--fg);cursor:pointer;font-size:12px;}' +
    '#top button.go{background:var(--accent);color:#fff;border-color:var(--accent);font-weight:600;}' +
    '#cols{flex:1;min-height:0;display:flex;overflow-x:auto;}' +
    '.col{flex:1 1 0;min-width:210px;border-right:1px solid var(--border);display:flex;flex-direction:column;}' +
    '.col:last-child{border-right:0;}.col:nth-child(even){background:var(--panel);}' +
    '.col-h{flex:none;padding:5px 10px;font:600 10px var(--mono);letter-spacing:.03em;text-transform:uppercase;color:var(--muted);border-bottom:1px solid var(--border);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}' +
    '.col-b{flex:1;overflow-y:auto;padding:3px 0;}' +
    '.row{display:flex;align-items:center;gap:8px;padding:5px 9px 5px 10px;cursor:pointer;font:12px var(--mono);color:var(--fg);border:0;background:none;width:100%;text-align:left;box-sizing:border-box;}' +
    '.row:hover{background:var(--code);}.row.sel{background:var(--accent);color:#fff;}' +
    '.row.sel .sub,.row.sel .chev{color:rgba(255,255,255,.85);}' +
    '.row .nm{flex:1;min-width:0;overflow:hidden;}.row .nm .t{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
    '.row .sub{color:var(--muted);font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
    '.row .chev{flex:none;color:var(--muted);}' +
    '.dot{flex:none;width:9px;height:9px;border-radius:50%;}.dot.dom{background:var(--dom);}.dot.host{background:var(--host);border-radius:2px;}.dot.ns{background:var(--ns);}' +
    '.mount{flex:none;border:1px solid var(--accent);background:var(--accent);color:#fff;border-radius:6px;font:10px var(--mono);padding:2px 9px;cursor:pointer;}' +
    '.mount.done{background:var(--code);color:var(--muted);border-color:var(--border);cursor:default;}.row.sel .mount{border-color:#fff;}' +
    '.empty{color:var(--muted);font:11px var(--mono);padding:10px;}.empty.err{color:var(--err);}' +
    '#status{flex:none;padding:5px 10px;border-top:1px solid var(--border);font:11px var(--mono);color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}#status .ok{color:var(--ok);}#status .err{color:var(--err);}' +
    '#legend{flex:none;display:flex;gap:16px;padding:5px 10px;border-top:1px solid var(--border);font:11px var(--mono);color:var(--muted);flex-wrap:wrap;}#legend span{display:flex;align-items:center;gap:6px;}';
  style.textContent = (R && R.text('styles', 'servers')) || DEFAULT_CSS;
  document.head.appendChild(style);

  function el(t, c, txt) { var e = document.createElement(t); if (c) e.className = c; if (txt != null) e.textContent = txt; return e; }
  function assign(a, b) { var o = {}; for (var k in a) o[k] = a[k]; for (k in b) o[k] = b[k]; return o; }

  // ---- header: editable, pre-filled DoH resolver + Rescan (no title label) ---------------------------------------
  var resolverIn = el('input'); resolverIn.type = 'text'; resolverIn.spellcheck = false;
  resolverIn.placeholder = S('resolverPlaceholder', 'DoH resolver URL, e.g. https://resolver.example/dns-query');
  var rescan = el('button', 'go'); rescan.type = 'button'; rescan.textContent = S('rescan', 'Rescan');
  var top = el('div'); top.id = 'top';
  top.appendChild(el('label', null, S('doh', 'DoH'))); top.appendChild(resolverIn); top.appendChild(rescan);
  var colsEl = el('div'); colsEl.id = 'cols';
  var statusEl = el('div'); statusEl.id = 'status'; statusEl.textContent = S('starting', 'Starting …');
  var legend = el('div'); legend.id = 'legend';
  function legItem(cls, txt) { var s = el('span'); s.appendChild(el('i', 'dot ' + cls)); s.appendChild(document.createTextNode(' ' + txt)); return s; }
  legend.appendChild(legItem('dom', S('legendDomain', 'browsing domain')));
  legend.appendChild(legItem('host', S('legendHost', 'CDMI host (_cdmi._tcp)')));
  legend.appendChild(legItem('ns', S('legendNs', 'namespace (well-known)')));
  document.body.appendChild(top); document.body.appendChild(colsEl); document.body.appendChild(statusEl); document.body.appendChild(legend);
  if (CTX.resize) CTX.resize(920, 560);
  if (CTX.setTitle) CTX.setTitle(S('title', 'servers'));

  function setStatus(t, cls) { statusEl.innerHTML = ''; statusEl.appendChild(el('span', cls || '', t)); }

  // ---- DNS wire format (RFC 1035 / RFC 8484) ---------------------------------------------------------------------
  var T_PTR = 12, T_TXT = 16, T_SRV = 33;
  function encodeName(name) {
    var out = [], parts = name.replace(/\.$/, '').split('.');
    for (var i = 0; i < parts.length; i++) {
      var b = []; for (var j = 0; j < parts[i].length; j++) b.push(parts[i].charCodeAt(j) & 0xff);
      out.push(b.length); out = out.concat(b);
    }
    out.push(0); return out;
  }
  function buildQuery(name, qtype) {
    var id = (Math.random() * 65535) | 0;
    var h = [(id >> 8) & 255, id & 255, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0];   // RD set, one question
    return new Uint8Array(h.concat(encodeName(name)).concat([(qtype >> 8) & 255, qtype & 255, 0, 1]));  // QTYPE, QCLASS=IN
  }
  function readName(u, off) {
    var labels = [], jumped = false, ret = off, guard = 0;
    while (guard++ < 128) {
      var len = u[off];
      if (len === undefined) break;
      if (len === 0) { off++; break; }
      if ((len & 0xc0) === 0xc0) { var ptr = ((len & 0x3f) << 8) | u[off + 1]; if (!jumped) ret = off + 2; off = ptr; jumped = true; continue; }
      off++; var s = ''; for (var i = 0; i < len; i++) s += String.fromCharCode(u[off + i]); off += len; labels.push(s);
    }
    return { name: labels.join('.'), next: jumped ? ret : off };
  }
  function decodeAnswers(ab) {
    var u = new Uint8Array(ab), dv = new DataView(ab);
    if (u.length < 12) return [];
    var qd = dv.getUint16(4), an = dv.getUint16(6), off = 12, i, r;
    for (i = 0; i < qd; i++) { r = readName(u, off); off = r.next + 4; }
    var out = [];
    for (i = 0; i < an; i++) {
      var rn = readName(u, off); off = rn.next;
      var type = dv.getUint16(off), rdlen = dv.getUint16(off + 8); off += 10;
      var rdstart = off, data = null;
      if (type === T_PTR) { data = readName(u, off).name; }
      else if (type === T_SRV) { data = { priority: dv.getUint16(off), weight: dv.getUint16(off + 2), port: dv.getUint16(off + 4), target: readName(u, off + 6).name }; }
      else if (type === T_TXT) {
        var txt = {}, p = off, end = off + rdlen;
        while (p < end) { var l = u[p++], seg = ''; for (var k = 0; k < l; k++) seg += String.fromCharCode(u[p + k]); p += l; var eq = seg.indexOf('='); if (eq >= 0) txt[seg.slice(0, eq)] = seg.slice(eq + 1); else if (seg) txt[seg] = ''; }
        data = txt;
      }
      out.push({ name: rn.name, type: type, data: data });
      off = rdstart + rdlen;
    }
    return out;
  }
  async function doh(resolver, name, qtype) {
    var res = await fetch(resolver, { method: 'POST', headers: { 'content-type': 'application/dns-message', 'accept': 'application/dns-message' }, body: buildQuery(name, qtype), credentials: 'omit', cache: 'no-store' });
    if (!res.ok) throw new Error('DoH ' + res.status);
    return decodeAnswers(await res.arrayBuffer());
  }

  // ---- discovery -------------------------------------------------------------------------------------------------
  var boot = { resolver: '', browse_domains: [] };
  var cache = { domains: null, hosts: {}, ns: {} };     // memoized per (re)scan
  var sel = { domain: null, host: null };

  async function readBoot() {
    var base = CTX.baseURI || (HOME + '/'); if (!/\/$/.test(base)) base += '/';
    try {
      var res = await fetch(base + 'cdmi_domains/?metadata=cdmi_domain_doh', { headers: assign({ Accept: 'application/cdmi-domain' }, HDRS), credentials: 'same-origin', cache: 'no-store' });
      if (res.ok) {
        var j = await res.json(), it = (j.metadata || {}).cdmi_domain_doh;
        if (it && typeof it === 'object') return { resolver: String(it.resolver || ''), browse_domains: Array.isArray(it.browse_domains) ? it.browse_domains.slice() : [] };
      }
    } catch (e) { /* no item, or not readable: fall back to an empty, user-editable resolver */ }
    return { resolver: '', browse_domains: [] };
  }
  function resolver() { return (resolverIn.value || '').trim(); }
  function unescapeLabel(s) { return s.replace(/\\(\d{3})/g, function (_, d) { return String.fromCharCode(parseInt(d, 10)); }).replace(/\\(.)/g, '$1'); }

  async function domainList() {
    if (cache.domains) return cache.domains;
    var set = {}, order = [];
    boot.browse_domains.forEach(function (d) { d = d.replace(/\.$/, ''); if (!set[d]) { set[d] = 1; order.push(d); } });
    // enumerate further browsing domains (b._dns-sd._udp) from each seed
    for (var i = 0; i < boot.browse_domains.length; i++) {
      try {
        var a = await doh(resolver(), 'b._dns-sd._udp.' + boot.browse_domains[i], T_PTR);
        a.forEach(function (r) { if (r.type === T_PTR && r.data) { var d = r.data.replace(/\.$/, ''); if (!set[d]) { set[d] = 1; order.push(d); } } });
      } catch (e) { /* enumeration is best-effort */ }
    }
    cache.domains = order; return order;
  }
  async function hostsIn(domain) {
    if (cache.hosts[domain]) return cache.hosts[domain];
    var ptr = await doh(resolver(), '_cdmi._tcp.' + domain, T_PTR);
    var instances = ptr.filter(function (r) { return r.type === T_PTR && r.data; }).map(function (r) { return r.data; });
    var hosts = [];
    for (var i = 0; i < instances.length; i++) {
      var inst = instances[i], srvA, txtA;
      try { srvA = await doh(resolver(), inst, T_SRV); } catch (e) { continue; }
      var srv = srvA.filter(function (r) { return r.type === T_SRV; })[0]; if (!srv || !srv.data) continue;
      try { txtA = await doh(resolver(), inst, T_TXT); } catch (e) { txtA = []; }
      var txt = (txtA.filter(function (r) { return r.type === T_TXT; })[0] || {}).data || {};
      var target = srv.data.target.replace(/\.$/, ''), port = srv.data.port;
      var origin = 'https://' + target + (port === 443 ? '' : ':' + port);
      var label = txt.name || unescapeLabel(inst.split('.')[0]);
      hosts.push({ name: label, origin: origin, ver: txt.ver || '' });
    }
    cache.hosts[domain] = hosts; return hosts;
  }
  async function namespacesOf(origin) {
    if (cache.ns[origin]) return cache.ns[origin];
    if (!D.wellKnown) throw new Error(S('noDiscovery', 'this desktop does not support namespace discovery'));
    var listed = await D.wellKnown(origin);
    var out = ((listed && listed.namespaces) || []).filter(function (n) { return n && n.base && n.tls !== false; });
    cache.ns[origin] = out; return out;
  }
  function mountedBases() { try { return ((D.mounted && D.mounted()) || []).map(function (d) { return d.base.replace(/\/$/, ''); }); } catch (e) { return []; } }

  // ---- rendering -------------------------------------------------------------------------------------------------
  function col(title) { var c = el('div', 'col'); c.appendChild(el('div', 'col-h', title)); var b = el('div', 'col-b'); c.appendChild(b); c._b = b; return c; }
  function row(opts) {
    var r = el(opts.mount !== undefined ? 'div' : 'button', 'row' + (opts.sel ? ' sel' : ''));
    if (opts.dot) r.appendChild(el('i', 'dot ' + opts.dot));
    var nm = el('div', 'nm'); nm.appendChild(el('div', 't', opts.name)); if (opts.sub) nm.appendChild(el('div', 'sub', opts.sub)); r.appendChild(nm);
    if (opts.mount !== undefined) {
      var mb = el('button', 'mount' + (opts.mounted ? ' done' : ''), opts.mounted ? S('mounted', 'Mounted') : S('mount', 'Mount'));
      if (!opts.mounted) mb.addEventListener('click', function (ev) { ev.stopPropagation(); opts.mount(mb); });
      r.appendChild(mb);
    } else if (opts.chev) r.appendChild(el('span', 'chev', '›'));
    if (opts.onClick) r.addEventListener('click', opts.onClick);
    return r;
  }
  // Each column memoizes its element so an async fill can drop in without redrawing siblings.
  function render() {
    colsEl.textContent = '';
    var c1 = col(S('colDomains', 'DNS Domains'));
    if (!resolver()) { c1._b.appendChild(el('div', 'empty', S('emptyResolver', 'Enter a DoH resolver URL above, then Rescan.'))); colsEl.appendChild(c1); colsEl.appendChild(col(S('colHosts', 'Hosts'))); colsEl.appendChild(col(S('colNamespaces', 'Namespaces'))); return; }
    fill(c1._b, domainList(), function (domains) {
      if (!domains.length) return [el('div', 'empty', S('emptyNoDomains', 'No browsing domains.'))];
      return domains.map(function (d) {
        return row({ name: d, dot: 'dom', chev: true, sel: d === sel.domain, onClick: function () { sel.domain = d; sel.host = null; setStatus('PTR _cdmi._tcp.' + d); render(); } });
      });
    });
    colsEl.appendChild(c1);

    var c2 = col(sel.domain ? S('colHosts', 'Hosts') + ' · ' + sel.domain : S('colHosts', 'Hosts'));
    if (!sel.domain) c2._b.appendChild(el('div', 'empty', S('emptySelectDomain', 'Select a domain.')));
    else fill(c2._b, hostsIn(sel.domain), function (hosts) {
      if (!hosts.length) return [el('div', 'empty', S('emptyNoHosts', 'No CDMI hosts advertised in {d}.', { d: sel.domain }))];
      return hosts.map(function (h) {
        return row({ name: h.name, sub: h.origin.replace(/^https:\/\//, '') + (h.ver ? '  · ' + h.ver : ''), dot: 'host', chev: true, sel: sel.host && sel.host.origin === h.origin,
          onClick: function () { sel.host = h; setStatus('GET ' + h.origin + '/.well-known/cdmi/cdmi_namespaces/'); render(); } });
      });
    });
    colsEl.appendChild(c2);

    var c3 = col(sel.host ? S('colNamespaces', 'Namespaces') + ' · ' + sel.host.name : S('colNamespaces', 'Namespaces'));
    if (!sel.host) c3._b.appendChild(el('div', 'empty', S('emptySelectHost', 'Select a host.')));
    else fill(c3._b, namespacesOf(sel.host.origin), function (list) {
      if (!list.length) return [el('div', 'empty', S('emptyNoNamespaces', 'This host advertises no namespaces.'))];
      var have = mountedBases();
      return list.map(function (n) {
        var isMounted = have.indexOf(n.base.replace(/\/$/, '')) >= 0;
        return row({ name: n.name, sub: n.base, dot: 'ns', mounted: isMounted,
          mount: function () {
            if (D.mount && D.mount(n.base, n.name)) { setStatus('Mounted ' + n.name + '  →  ' + n.base, 'ok'); render(); }
            else setStatus('Could not mount ' + n.base, 'err');
          } });
      });
    });
    colsEl.appendChild(c3);
    if (sel.host) colsEl.scrollLeft = colsEl.scrollWidth;
  }
  // Fill a column body from a promise: show "Reading ..." until it resolves, then the produced rows.
  function fill(body, promise, toRows) {
    body.appendChild(el('div', 'empty', S('reading', 'Reading …')));
    Promise.resolve(promise).then(function (v) {
      body.textContent = ''; toRows(v).forEach(function (n) { body.appendChild(n); });
    }, function (e) {
      body.textContent = ''; body.appendChild(el('div', 'empty err', (e && e.message || e)));
      setStatus('' + (e && e.message || e), 'err');
    });
  }

  async function start() {
    setStatus(S('readingBoot', 'Reading cdmi_domain_doh on the root domain …'));
    boot = await readBoot();
    if (boot.resolver) resolverIn.value = boot.resolver;
    cache = { domains: null, hosts: {}, ns: {} };
    if (resolver()) setStatus('DoH resolver ' + resolver() + (boot.browse_domains.length ? '  ·  seeds: ' + boot.browse_domains.join(', ') : ''));
    else setStatus(S('noBootItem', 'No cdmi_domain_doh item; enter a DoH resolver URL and Rescan.'));
    render();
  }
  rescan.addEventListener('click', function () { sel = { domain: null, host: null }; cache = { domains: null, hosts: {}, ns: {} }; setStatus('Rescanning with ' + (resolver() || '(no resolver)')); render(); });
  resolverIn.addEventListener('keydown', function (e) { if (e.key === 'Enter') rescan.click(); });
  start();
})();
