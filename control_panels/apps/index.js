/*!
 * control_panels/apps/index.js — the Apps control panel.
 *
 * Shows the known applications and the file types (media types and extensions) each one claims, and lets the user
 * add or remove apps. The registry is ~/prefs/apps.json: { version, apps: [<app path>, ...], links: { <type>: <app> } }.
 * The types an app claims are NOT entered here -- an app declares them in its own resource fork, rsrc/filetypes.json,
 * a list of { mimetypes, extensions, icon }. This panel reads those declarations to fill the two columns:
 *   - COLUMN 1, Applications: each app, expandable to the file types it handles, each with its icon.
 *   - COLUMN 2, File types: every type across the added apps, each with its icon and the application it is opened by;
 *     where more than one app claims a type, a menu chooses which (written to apps.json "links").
 * cvwm reads the same registry to decide which app opens an object and which icon the object shows.
 * Follows the shared cvwm.dark light/dark signal, like the other cvwm applications.
 */
(function () {
  var c = window.CDMI_CONTEXT, D = document;
  var HOME = c.homeURI || null;

  /* ---- localization: the five languages cvwm ships (en, es, fr, hi, zh); follows the live "cvwm.locale" signal,
     the same same-origin localStorage key the Locale panel writes and every app re-renders on. ---- */
  var STRINGS = {
    en: { title: 'Apps', applications: 'Applications', add: 'Add app…', remove: 'Remove', discover: 'Discover',
          noApps: 'No apps. Use Add app… to register one.', noTypes: 'No file types.',
          typeOne: '{n} type', typeMany: '{n} types', none: '—',
          pick: 'Choose an application container', signIn: 'Sign in to manage applications.',
          scanning: 'Scanning your home…', discNone: 'No new applications found.', discOne: 'Added 1 application.', discMany: 'Added {n} applications.' },
    es: { title: 'Aplicaciones', applications: 'Aplicaciones', add: 'Añadir app…', remove: 'Quitar', discover: 'Descubrir',
          noApps: 'No hay aplicaciones. Usa Añadir app… para registrar una.', noTypes: 'No hay tipos de archivo.',
          typeOne: '{n} tipo', typeMany: '{n} tipos', none: '—',
          pick: 'Elige un contenedor de aplicación', signIn: 'Inicia sesión para gestionar las aplicaciones.',
          scanning: 'Explorando tu carpeta personal…', discNone: 'No se encontraron aplicaciones nuevas.', discOne: 'Se añadió 1 aplicación.', discMany: 'Se añadieron {n} aplicaciones.' },
    fr: { title: 'Applications', applications: 'Applications', add: 'Ajouter une app…', remove: 'Retirer', discover: 'Découvrir',
          noApps: 'Aucune application. Utilisez Ajouter une app… pour en enregistrer une.', noTypes: 'Aucun type de fichier.',
          typeOne: '{n} type', typeMany: '{n} types', none: '—',
          pick: 'Choisissez un conteneur d’application', signIn: 'Connectez-vous pour gérer les applications.',
          scanning: 'Analyse de votre dossier personnel…', discNone: 'Aucune nouvelle application trouvée.', discOne: '1 application ajoutée.', discMany: '{n} applications ajoutées.' },
    hi: { title: 'ऐप्स', applications: 'ऐप्लिकेशन', add: 'ऐप जोड़ें…', remove: 'हटाएँ', discover: 'खोजें',
          noApps: 'कोई ऐप नहीं। पंजीकृत करने के लिए ऐप जोड़ें… का उपयोग करें।', noTypes: 'कोई फ़ाइल प्रकार नहीं।',
          typeOne: '{n} प्रकार', typeMany: '{n} प्रकार', none: '—',
          pick: 'एक ऐप्लिकेशन कंटेनर चुनें', signIn: 'ऐप्लिकेशन प्रबंधित करने के लिए साइन इन करें।',
          scanning: 'आपका होम स्कैन किया जा रहा है…', discNone: 'कोई नई ऐप्लिकेशन नहीं मिली।', discOne: '1 ऐप्लिकेशन जोड़ी गई।', discMany: '{n} ऐप्लिकेशन जोड़ी गईं।' },
    zh: { title: '应用', applications: '应用程序', add: '添加应用…', remove: '移除', discover: '发现',
          noApps: '没有应用。使用“添加应用…”来注册一个。', noTypes: '没有文件类型。',
          typeOne: '{n} 种类型', typeMany: '{n} 种类型', none: '—',
          pick: '选择一个应用程序容器', signIn: '登录以管理应用程序。',
          scanning: '正在扫描您的主目录…', discNone: '未发现新的应用程序。', discOne: '已添加 1 个应用程序。', discMany: '已添加 {n} 个应用程序。' }
  };
  function baseLang(tag) { return String(tag || 'en').toLowerCase().split('-')[0]; }
  function readLocaleLang() { try { var s = localStorage.getItem('cvwm.locale'); if (s) { var o = JSON.parse(s); if (o && o.language) return o.language; } } catch (e) {} return (c.locale && c.locale.language) || 'en'; }
  var lang = baseLang(readLocaleLang());
  function tr(k) { var s = STRINGS[lang] || STRINGS.en; return (s && s[k] != null) ? s[k] : STRINGS.en[k]; }

  /* ---- CSS (platinum light / dark) ---- */
  var CSS =
    ':root{--std:#60a0c0;--hi:#c06077;--grey:#bfbfbf;--lt:rgba(255,255,255,.6);--dk:rgba(0,0,0,.55);' +
      '--sans:Helvetica,"Nimbus Sans","Liberation Sans",Arial,sans-serif;--mono:"DejaVu Sans Mono","Liberation Mono",Menlo,Consolas,monospace;' +
      '--fg:#000;--dim:#555;--field:#fff;--sel:#000080;--band:#eef3f7;--rowline:rgba(128,128,128,.16)}' +
    'body.dark{--grey:#333b41;--lt:rgba(255,255,255,.16);--dk:rgba(0,0,0,.6);--fg:#e8edf1;--dim:#8a929a;--field:#15191c;--sel:#3a6ea5;--band:#222c35;--rowline:rgba(255,255,255,.08)}' +
    'html,body{margin:0;height:100%}' +
    'body{background:var(--grey);color:var(--fg);font:13px/1.3 var(--sans);display:flex;flex-direction:column;overflow:hidden;-webkit-user-select:none;user-select:none}' +
    '*{box-sizing:border-box}' +
    '#cols{flex:1;min-height:0;display:grid;grid-template-columns:1fr 1fr;grid-template-rows:minmax(0,1fr)}' +
    '.pane{display:flex;flex-direction:column;min-width:0;min-height:0}' +
    'h4{margin:0;font:700 13px var(--sans);color:var(--fg);padding:10px 12px 6px}' +
    '.scroll{flex:1;overflow:auto;background:var(--field);margin:0 10px 8px;border:2px solid;border-color:var(--dk) var(--lt) var(--lt) var(--dk)}' +
    /* col 1 */
    '.app>.r{display:flex;align-items:center;gap:7px;padding:6px 9px;border-bottom:1px solid var(--rowline);cursor:default}' +
    '.app>.r.sel{background:var(--sel);color:#fff}' +
    '.tw{width:12px;flex:none;text-align:center;color:var(--dim);font-size:11px}.app>.r.sel .tw{color:#fff}' +
    '.ic{display:inline-flex;align-items:center;justify-content:center;flex:none}.ic svg{display:block}.ic img{display:block;object-fit:contain}' +
    '.r b{font:600 13px var(--sans)}.r .n{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '.r .claims{font:11px var(--mono);color:var(--dim)}.app>.r.sel .claims{color:#cdd}' +
    '.types{background:var(--band);padding:2px 0 5px}' +
    '.type{display:flex;align-items:center;gap:8px;padding:3px 10px 3px 28px;font:12px var(--mono);color:var(--fg)}' +
    '.type .ext{color:var(--dim)}' +
    /* col 2 */
    'table{width:100%;border-collapse:collapse;font:12px var(--sans);table-layout:fixed}' +
    'td{padding:4px 8px;border-bottom:1px solid var(--rowline);vertical-align:middle}' +
    'td.id{font-family:var(--mono);font-size:11px;word-break:break-word}' +
    'td.icc{width:28px}td.by{width:40%;overflow:hidden;text-overflow:ellipsis}' +
    'select{font:12px var(--sans);background:var(--field);color:var(--fg);border:2px solid;border-color:var(--dk) var(--lt) var(--lt) var(--dk);padding:0 4px;max-width:150px}' +
    '.foot{flex:none;display:flex;gap:7px;align-items:center;padding:8px 12px;border-top:1px solid var(--lt)}' +
    'button.btn{height:26px;padding:0 12px;background:var(--grey);font:600 12px var(--sans);color:var(--fg);border:2px solid;border-color:var(--lt) var(--dk) var(--dk) var(--lt)}' +
    'button.btn:active{border-color:var(--dk) var(--lt) var(--lt) var(--dk)}button.btn:disabled{color:var(--dim)}' +
    '.foot .msg{flex:1;min-width:0;font:12px var(--sans);color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '.empty{color:var(--dim);font:12px var(--sans);padding:12px}';
  D.head.appendChild(mk('style', { text: CSS }));

  function mk(tag, a, kids) { var e = D.createElement(tag); a = a || {}; for (var k in a) { if (k === 'text') e.textContent = a[k]; else if (k === 'html') e.innerHTML = a[k]; else e.setAttribute(k, a[k]); } (kids || []).forEach(function (n) { if (n) e.appendChild(n); }); return e; }
  function headers(extra) { var h = {}; var ch = c.headers || {}; for (var k in ch) h[k] = ch[k]; if (extra) for (var j in extra) h[j] = extra[j]; return h; }
  function b64text(s) { try { return decodeURIComponent(escape(atob(String(s).replace(/\s+/g, '')))); } catch (e) { try { return atob(s); } catch (_) { return ''; } } }
  function appURIof(rel) { return /^https?:/i.test(rel) ? rel : HOME + String(rel).replace(/^\//, ''); }
  function appName(rel) { return String(rel).replace(/\/$/, '').split('/').pop(); }

  async function readJSON(url) {
    var res = await fetch(url + '?value', { headers: headers({ Accept: 'application/cdmi-object' }) });
    if (!res.ok) throw new Error(String(res.status));
    var rep = await res.json(), raw = rep.value;
    if (raw && typeof raw === 'object') return raw;                   // the server returned the value already parsed (valuetransferencoding "json")
    raw = raw || ''; if (rep.valuetransferencoding === 'base64') raw = b64text(raw);
    return JSON.parse(raw);
  }
  // An app's file-type manifest. The resource fork preserves file extensions, so it is the object "rsrc/filetypes.json".
  async function readManifest(uri) {
    try { var m = await readJSON(uri + 'rsrc/filetypes.json'); if (m && Array.isArray(m.types)) return m.types; } catch (e) { /* none */ }
    return [];
  }

  /* ---- icons: a built-in name via the desktop, or the app's own / a resource icon fetched as a data URL ---- */
  var iconCache = {};
  function builtinIcon(name, size) { try { var s = c.desktop && c.desktop.iconSvg && c.desktop.iconSvg(name, size || 20); return s || null; } catch (e) { return null; } }
  async function dataURLfor(objURL) {
    if (iconCache[objURL] !== undefined) return iconCache[objURL];
    try {
      var res = await fetch(objURL + '?value', { headers: headers({ Accept: 'application/cdmi-object' }) });
      if (!res.ok) throw 0;
      var rep = await res.json(), val = rep.value || '', mime = rep.mimetype || (/\.svg$/i.test(objURL) ? 'image/svg+xml' : 'image/png');
      var url = rep.valuetransferencoding === 'base64' ? ('data:' + mime + ';base64,' + val.replace(/\s+/g, '')) : ('data:' + mime + ';charset=utf-8,' + encodeURIComponent(val));
      iconCache[objURL] = url; return url;
    } catch (e) { iconCache[objURL] = null; return null; }
  }
  // Render a type's icon into a given <span class=ic>. icon spec: a string name/path, or undefined (the app's own icon).
  function paintIcon(span, appURI, icon, size) {
    size = size || 18;
    span.style.width = size + 'px'; span.style.height = size + 'px';
    var bi = icon && builtinIcon(icon, size);
    if (bi) { span.innerHTML = bi; return; }
    var objURL = icon ? (appURI + icon) : null;   // a resource path within the app
    var tries = objURL ? [objURL] : [appURI + 'index.svg', appURI + 'index.png'];
    (function next(i) {
      if (i >= tries.length) { span.innerHTML = builtinIcon('object', size) || ''; return; }
      dataURLfor(tries[i]).then(function (u) { if (u) { span.textContent = ''; span.appendChild(mk('img', { src: u, width: size, height: size })); } else next(i + 1); });
    })(0);
  }

  /* ---- state ---- */
  var cfg = { version: 1, apps: [], links: {} };
  var manifests = {};     // appURI -> [ {mimetypes, extensions, icon}, ... ]
  var selApp = null;      // selected app rel
  var expanded = {};      // app rel -> bool

  function byName(a, b) { var x = appName(a).toLowerCase(), y = appName(b).toLowerCase(); return x < y ? -1 : x > y ? 1 : 0; }
  async function loadAll() {
    try { cfg = await readJSON(HOME + 'prefs/apps.json'); } catch (e) { cfg = { version: 1, apps: [], links: {} }; }
    if (!Array.isArray(cfg.apps)) cfg.apps = []; if (!cfg.links) cfg.links = {};
    cfg.apps.sort(byName);                              // applications are listed in alphabetical order
    manifests = {};
    for (var i = 0; i < cfg.apps.length; i++) {
      var rel = cfg.apps[i], uri = appURIof(rel);
      manifests[uri] = await readManifest(uri);
    }
  }
  async function save() {
    try {
      var res = await fetch(HOME + 'prefs/apps.json', { method: 'PUT', headers: headers({ 'Content-Type': 'application/cdmi-object', Accept: 'application/cdmi-object' }),
        body: JSON.stringify({ mimetype: 'application/json', metadata: {}, valuetransferencoding: 'utf-8', value: JSON.stringify(cfg, null, 2) }) });
      if (!res.ok) console.warn('apps.json save returned ' + res.status);
      else if (c.desktop && c.desktop.reloadApps) { try { c.desktop.reloadApps(); } catch (e) {} }   // let cvwm pick up the change now (dispatch + icons)
    } catch (e) { console.warn('apps.json save failed', e); }
  }

  /* ---- build: two equal-height lists side by side (no divider, no status), Add/Remove in a shared footer ---- */
  var col1 = mk('div', { class: 'scroll' }), col2wrap = mk('div', { class: 'scroll' });
  var addBtn = mk('button', { class: 'btn', type: 'button', text: tr('add') });
  var discoverBtn = mk('button', { class: 'btn', type: 'button', text: tr('discover') });
  var remBtn = mk('button', { class: 'btn', type: 'button', text: tr('remove') });
  var footMsg = mk('span', { class: 'msg' });
  var appsH4 = mk('h4', { text: tr('applications') });
  var cols = mk('div', { id: 'cols' }, [
    mk('div', { class: 'pane' }, [appsH4, col1]),
    mk('div', { class: 'pane' }, [mk('h4', { html: '&nbsp;' }), col2wrap])   // an empty heading keeps the two lists aligned
  ]);
  D.body.appendChild(cols);
  D.body.appendChild(mk('div', { class: 'foot' }, [addBtn, discoverBtn, remBtn, footMsg]));
  function setFootMsg(t) { footMsg.textContent = t || ''; }

  function claimSummary(types) { var n = types.length; if (!n) return tr('none'); return (n === 1 ? tr('typeOne') : tr('typeMany')).replace('{n}', n); }

  function renderApps() {
    col1.textContent = '';
    if (!cfg.apps.length) { col1.appendChild(mk('div', { class: 'empty', text: tr('noApps') })); return; }
    cfg.apps.forEach(function (rel) {
      var uri = appURIof(rel), types = manifests[uri] || [], box = mk('div', { class: 'app' });
      var icSpan = mk('span', { class: 'ic' });
      var row = mk('div', { class: 'r' + (selApp === rel ? ' sel' : '') }, [
        mk('span', { class: 'tw', text: types.length ? (expanded[rel] ? '▾' : '▸') : '' }),
        icSpan, mk('span', { class: 'n' }, [mk('b', { text: appName(rel) })]),
        mk('span', { class: 'claims', text: claimSummary(types) })
      ]);
      paintIcon(icSpan, uri, undefined, 20);
      row.addEventListener('click', function () { selApp = rel; if (types.length) expanded[rel] = !expanded[rel]; renderApps(); remBtn.disabled = false; });
      box.appendChild(row);
      if (expanded[rel] && types.length) {
        var tl = mk('div', { class: 'types' });
        types.forEach(function (t) {
          var ti = mk('span', { class: 'ic' });
          var line = mk('div', { class: 'type' }, [ti, mk('span', { text: (t.mimetypes || []).join(', ') }), mk('span', { class: 'ext', text: (t.extensions || []).map(function (e) { return '.' + e; }).join(' ') })]);
          paintIcon(ti, uri, t.icon, 18); tl.appendChild(line);
        });
        box.appendChild(tl);
      }
      col1.appendChild(box);
    });
  }

  // One row per individual media type and per individual extension, across the apps. Each is resolved to its opener
  // (a links override, else the first app -- alphabetically -- that claims it); a type more than one app claims gets a
  // menu. The link key is the identifier itself: a ".ext" for an extension or the media type for a media type.
  function typeRows() {
    var rows = [], seen = {};
    function add(id, icon, uri, rel) {
      var k = id.toLowerCase();
      if (seen[k]) { if (seen[k].claimants.indexOf(rel) < 0) seen[k].claimants.push(rel); return; }
      var r = { id: id, icon: icon, uri: uri, owner: rel, claimants: [rel] }; seen[k] = r; rows.push(r);
    }
    cfg.apps.forEach(function (rel) {
      var uri = appURIof(rel);
      (manifests[uri] || []).forEach(function (t) {
        (t.mimetypes || []).forEach(function (m) { add(String(m), t.icon, uri, rel); });
        (t.extensions || []).forEach(function (e) { add('.' + String(e), t.icon, uri, rel); });
      });
    });
    return rows;
  }
  function openerFor(r) { var k = r.id.toLowerCase(); if (cfg.links && cfg.links[k]) return cfg.links[k]; return r.owner; }

  function renderTypes() {
    var rows = typeRows(), tb = mk('tbody');
    if (!rows.length) tb.appendChild(mk('tr', {}, [mk('td', { colspan: '3' }, [mk('div', { class: 'empty', text: tr('noTypes') })])]));
    rows.forEach(function (r) {
      var ic = mk('span', { class: 'ic' }); paintIcon(ic, r.uri, r.icon, 18);
      var opener = openerFor(r), openerCell;
      if (r.claimants.length > 1) {                               // claimed by more than one app: a menu chooses the opener
        var sel = mk('select');
        r.claimants.forEach(function (rel) { var op = mk('option', { value: rel, text: appName(rel) }); if (rel === opener) op.selected = true; sel.appendChild(op); });
        sel.addEventListener('change', function () { cfg.links[r.id.toLowerCase()] = sel.value; save(); });
        openerCell = mk('td', { class: 'by' }, [sel]);
      } else openerCell = mk('td', { class: 'by', text: appName(opener) });
      tb.appendChild(mk('tr', {}, [mk('td', { class: 'id', text: r.id }), mk('td', { class: 'icc' }, [ic]), openerCell]));
    });
    var tbl = mk('table', {}, [tb]); col2wrap.textContent = ''; col2wrap.appendChild(tbl);
  }

  function relabel() { if (c.setTitle) c.setTitle(tr('title')); appsH4.textContent = tr('applications'); addBtn.textContent = tr('add'); discoverBtn.textContent = tr('discover'); remBtn.textContent = tr('remove'); }
  function renderAll() { renderApps(); renderTypes(); remBtn.disabled = !selApp; }

  /* ---- add / remove ---- */
  addBtn.addEventListener('click', function () {
    if (!c.desktop || !c.desktop.pickObject) return;
    c.desktop.pickObject({ title: tr('pick'), startURI: (HOME ? HOME + 'apps/' : c.baseURI) || null,
      filter: function (name) { return /\/$/.test(name); } })
      .then(function (url) {
        if (!url) return;
        if (!/\/$/.test(url)) url += '/';
        var rel = (HOME && url.indexOf(HOME) === 0) ? url.slice(HOME.length) : url;    // store home-relative where possible
        if (cfg.apps.indexOf(rel) >= 0) return;
        cfg.apps.push(rel); selApp = rel; expanded[rel] = true;
        save().then(loadAll).then(renderAll);
      });
  });
  remBtn.addEventListener('click', function () {
    if (!selApp) return;
    var i = cfg.apps.indexOf(selApp); if (i < 0) return;
    cfg.apps.splice(i, 1); delete manifests[appURIof(selApp)]; selApp = null;
    save().then(renderAll);
  });

  /* ---- discover: walk the home for application containers (any container holding index.js) and register the ones not
     already listed. Home-relative paths with a trailing slash are stored, matching what Add app… records. ---- */
  var SKIP = { 'prefs/': 1, 'rsrc/': 1, 'control_panels/': 1, 'trash/': 1, '.trash/': 1 };   // config, resource forks, panels, trash
  async function listChildren(uri) {
    var res = await fetch(uri + '?children', { headers: headers({ Accept: 'application/cdmi-container' }) });
    if (!res.ok) return null;                                      // not a container, or unreadable
    var rep = await res.json();
    return Array.isArray(rep.children) ? rep.children : [];
  }
  async function discover() {
    var found = [], budget = { n: 0 }, MAXDEPTH = 6;
    async function walk(uri, rel, depth) {
      if (depth > MAXDEPTH || budget.n > 2000) return;
      var kids; try { kids = await listChildren(uri); } catch (e) { return; }
      if (kids === null) return;
      budget.n++;
      if (kids.indexOf('index.js') >= 0) { found.push(rel); return; }   // an application; do not descend into it (rsrc/, etc.)
      for (var i = 0; i < kids.length; i++) {
        var name = kids[i];
        if (!/\/$/.test(name)) continue;                           // containers only
        if (SKIP[name.toLowerCase()] || name.charAt(0) === '.') continue;
        await walk(uri + name, rel + name, depth + 1);
      }
    }
    await walk(HOME, '', 0);
    return found;
  }
  discoverBtn.addEventListener('click', function () {
    discoverBtn.disabled = true; addBtn.disabled = true; setFootMsg(tr('scanning'));
    discover().then(function (found) {
      var added = 0;
      found.forEach(function (rel) { if (cfg.apps.indexOf(rel) < 0) { cfg.apps.push(rel); added++; } });
      discoverBtn.disabled = false; addBtn.disabled = false;
      if (!added) { setFootMsg(tr('discNone')); return; }
      setFootMsg((added === 1 ? tr('discOne') : tr('discMany')).replace('{n}', added));
      save().then(loadAll).then(renderAll);
    }).catch(function (e) {
      discoverBtn.disabled = false; addBtn.disabled = false; setFootMsg('Scan failed: ' + e.message);
    });
  });

  /* ---- dark mode + live locale ---- */
  function setDark(on) { D.body.classList.toggle('dark', !!on); }
  try { setDark(localStorage.getItem('cvwm.dark') === 'on'); } catch (e) {}
  window.addEventListener('storage', function (ev) {
    if (ev.key === 'cvwm.dark') { setDark(ev.newValue === 'on'); return; }
    if (ev.key === 'cvwm.locale' && ev.newValue) {                        // the Locale panel (or another window) changed the language
      try { var nl = baseLang(JSON.parse(ev.newValue).language); if (nl !== lang) { lang = nl; relabel(); renderAll(); } } catch (e) {}
    }
  });

  /* ---- boot ---- */
  if (c.setTitle) c.setTitle(tr('title'));
  if (c.resize) c.resize(720, 460);
  if (!HOME) { D.body.textContent = ''; D.body.appendChild(mk('div', { class: 'empty', text: tr('signIn') })); }
  else loadAll().then(renderAll).catch(function (e) { console.warn('apps panel load failed', e); });
})();
