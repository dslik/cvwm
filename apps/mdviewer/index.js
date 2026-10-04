/*!
 * mdviewer for cvwm: opens a Markdown file and shows it rendered, GitHub style.
 *
 * A file arrives one of two ways: as a CDMI data object (CTX.startURI, when opened from a container), or dropped
 * onto the window. Either way its text is rendered to HTML by the small self-contained Markdown parser below and
 * shown in a GitHub-flavoured document. No external libraries: an app is a single file.
 *
 * The parser covers the GitHub-common subset: headings, bold/italic/strikethrough, inline and fenced code, links,
 * images, blockquotes, ordered/unordered/nested/task lists, tables, thematic breaks, autolinks, and hard breaks.
 * It is not a full CommonMark implementation, but it renders ordinary documents faithfully.
 */
(function () {
  'use strict';

  var CTX = window.CDMI_CONTEXT || {};
  var HEADERS = CTX.headers || {};
  // Resources: the app's own fork (CTX.rsrc), optional. Absent (a classic install) => every lookup falls back to the
  // built-in default. S() reads a string; the stylesheet is pulled where present.
  var R = CTX.rsrc || null;
  function S(id, fb) { var v = R && R.text('strings', id); return v == null ? fb : v; }
  var T_OBJECT = 'application/cdmi-object';

  /* ----------------------------------------------------------------- styles (GitHub markdown, light + dark) */
  var style = document.createElement('style');
  var DEFAULT_CSS =
    ':root{--fg:#1f2328;--muted:#59636e;--bg:#ffffff;--border:#d1d9e0;--code-bg:#eff1f3;--code-fg:#1f2328;' +
    '--quote-fg:#59636e;--link:#0969da;--accent:#0969da;--table-alt:#f6f8fa;--hr:#d1d9e0;}' +
    '@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--fg:#e6edf3;--muted:#9198a1;--bg:#0d1117;' +
    '--border:#3d444d;--code-bg:#151b23;--code-fg:#e6edf3;--quote-fg:#9198a1;--link:#4493f8;--accent:#4493f8;--table-alt:#151b23;--hr:#3d444d;}}' +
    'html,body{margin:0;height:100%;background:var(--bg);color:var(--fg);}' +
    'body{font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans",Helvetica,Arial,"Liberation Sans",sans-serif;}' +
    '#bar{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:8px;padding:6px 10px;background:var(--bg);' +
    'border-bottom:1px solid var(--border);}' +
    '#bar .name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;font-size:14px;}' +
    '#bar button{height:26px;padding:0 10px;font-size:13px;background:var(--code-bg);color:var(--fg);border:1px solid var(--border);border-radius:6px;cursor:pointer;}' +
    '#bar button:hover{border-color:var(--muted);}' +
    '#doc{max-width:900px;margin:0 auto;padding:28px 44px 80px;}' +
    '.empty{color:var(--muted);text-align:center;padding:80px 20px;}' +
    /* markdown elements */
    '.md h1,.md h2,.md h3,.md h4,.md h5,.md h6{margin:24px 0 16px;font-weight:600;line-height:1.25;}' +
    '.md h1{font-size:2em;padding-bottom:.3em;border-bottom:1px solid var(--border);}' +
    '.md h2{font-size:1.5em;padding-bottom:.3em;border-bottom:1px solid var(--border);}' +
    '.md h3{font-size:1.25em;}.md h4{font-size:1em;}.md h5{font-size:.875em;}.md h6{font-size:.85em;color:var(--muted);}' +
    '.md p{margin:0 0 16px;}.md a{color:var(--link);text-decoration:none;}.md a:hover{text-decoration:underline;}' +
    '.md strong{font-weight:600;}.md del{color:var(--muted);}' +
    '.md code{font:85% ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;' +
    'background:var(--code-bg);padding:.2em .4em;border-radius:6px;}' +
    '.md pre{background:var(--code-bg);padding:16px;border-radius:6px;overflow:auto;margin:0 0 16px;}' +
    '.md pre code{background:none;padding:0;font-size:85%;color:var(--code-fg);white-space:pre;}' +
    '.md blockquote{margin:0 0 16px;padding:0 1em;color:var(--quote-fg);border-left:.25em solid var(--border);}' +
    '.md blockquote>:last-child{margin-bottom:0;}' +
    '.md ul,.md ol{margin:0 0 16px;padding-left:2em;}.md li{margin:.25em 0;}.md li>ul,.md li>ol{margin:.25em 0;}' +
    '.md li.task{list-style:none;margin-left:-1.4em;}.md li.task input{margin:0 .4em 0 0;vertical-align:middle;}' +
    '.md table{border-collapse:collapse;margin:0 0 16px;display:block;width:max-content;max-width:100%;overflow:auto;}' +
    '.md th,.md td{border:1px solid var(--border);padding:6px 13px;}.md tr:nth-child(2n){background:var(--table-alt);}' +
    '.md th{font-weight:600;}' +
    '.md hr{height:1px;border:0;background:var(--hr);margin:24px 0;}' +
    '.md img{max-width:100%;box-sizing:border-box;}' +
    '.md kbd{font:85% ui-monospace,monospace;background:var(--code-bg);border:1px solid var(--border);border-radius:6px;padding:.1em .4em;box-shadow:inset 0 -1px 0 var(--border);}';
  style.textContent = (R && R.text('styles', 'mdviewer')) || DEFAULT_CSS;
  document.head.appendChild(style);

  function el(tag, props, kids) {
    var e = document.createElement(tag);
    for (var k in props) { if (k === 'text') e.textContent = props[k]; else if (k === 'html') e.innerHTML = props[k]; else e.setAttribute(k, props[k]); }
    (kids || []).forEach(function (c) { e.appendChild(c); });
    return e;
  }

  var nameEl = el('span', { class: 'name', text: S('title', 'mdviewer') });
  var openBtn = el('button', { type: 'button', title: S('openTitle', 'Open a Markdown object from a disk') }, [document.createTextNode(S('open', 'Open\u2026'))]);
  var bar = el('div', { id: 'bar' }, [nameEl, openBtn]);
  var doc = el('div', { id: 'doc', class: 'md' });
  document.body.appendChild(bar); document.body.appendChild(doc);
  if (CTX.resize) CTX.resize(900, 720);

  var NAME = S('title', 'mdviewer');
  var showingDoc = false;
  function showEmpty() {
    showingDoc = false;
    doc.className = 'md'; doc.innerHTML = '';
    setTitle(NAME);
    // The desktop shows a native drop pane over this app's (hidden) frame: a real element, so a dropped host file or
    // a dragged cvwm object lands on it directly. Once a document loads we call desktop.showApp and the frame shows.
    if (CTX.desktop && CTX.desktop.dropPane && CTX.id !== undefined) {
      CTX.desktop.dropPane(CTX.id, {
        label: S('openFile', 'Open a Markdown file'),
        openLabel: S('open', 'Open\u2026'),
        onOpen: openPicker,
        onFile: function (f) { var r = new FileReader(); r.onload = function () { render(String(r.result), f.name); }; r.readAsText(f); },
        onObject: function (url) { if (/^https:/i.test(url)) loadCdmi(url); }
      });
    }
  }
  function setTitle(t) { nameEl.textContent = t; if (CTX.setTitle) CTX.setTitle(t === NAME ? NAME : NAME + ' \u2014 ' + t); }

  // A click on an external (http/https) link opens it in Earthworm via the desktop, not in this app's frame.
  doc.addEventListener('click', function (ev) {
    var a = ev.target.closest && ev.target.closest('a[href]'); if (!a) return;
    var href = a.getAttribute('href') || '';
    if (a.getAttribute('data-ext') === '1' || /^https?:/i.test(href)) {
      ev.preventDefault();
      if (CTX.desktop && CTX.desktop.browse) CTX.desktop.browse(href);
      else if (CTX.open) CTX.open(href);
    } else if (href.charAt(0) === '#') {
      ev.preventDefault();   // in-page anchor: scroll to a heading of that id (we do not assign ids, so ignore)
    }
    // mailto: and other schemes are left to the frame's default (which the sandbox may block); that is acceptable.
  });

  function render(text, title) {
    showingDoc = true;
    if (CTX.desktop && CTX.desktop.showApp && CTX.id !== undefined) CTX.desktop.showApp(CTX.id);   // reveal the frame; the pane stops being a drop target
    doc.className = 'md';
    doc.innerHTML = mdToHtml(text);
    doc.scrollTop = 0; window.scrollTo(0, 0);
    setTitle(title || S('document', 'document'));
  }

  /* Open uses the desktop's common picker (a cvwm FVWM-styled window), filtered to Markdown objects. */
  function openPicker() {
    if (CTX.desktop && CTX.desktop.pickObject) {
      CTX.desktop.pickObject({
        title: S('openFile', 'Open a Markdown file'),
        startURI: CTX.baseURI || CTX.homeURI || null,
        filter: function (name) { return /\.(md|markdown|mdown|mkd)$/i.test(name); }
      }).then(function (url) { if (url) loadCdmi(url); });
    }
  }
  openBtn.addEventListener('click', openPicker);

  /* ----------------------------------------------------------------- open a CDMI object */
  async function loadCdmi(url) {
    var clean = url.replace(/[?#].*$/, '');
    try {
      var h = { Accept: T_OBJECT }; for (var k in HEADERS) h[k] = HEADERS[k];
      var res = await fetch(clean + '?objectName&mimetype&valuetransferencoding&value', { headers: h, redirect: 'follow', credentials: 'same-origin', cache: 'no-store' });
      if (res.url && !/^https:/i.test(res.url)) throw new Error(S('redirectNonHttps', 'redirected to a non-https URI'));
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var rep = await res.json();
      var enc = rep.valuetransferencoding || 'utf-8', v = rep.value || '', text;
      if (enc === 'base64') { try { text = new TextDecoder('utf-8', { fatal: true }).decode(b64(v)); } catch (e) { throw new Error(S('notUtf8', 'this object is not UTF-8 text')); } }
      else if (enc === 'json') text = JSON.stringify(v, null, 2);
      else text = v;
      render(text, rep.objectName || clean.split('/').pop() || S('document', 'document'));
    } catch (e) {
      doc.className = 'md';
      doc.innerHTML = '';
      doc.appendChild(el('div', { class: 'empty', html: escapeHtml(S('couldNotOpen', 'Could not open')) + ' <code>' + escapeHtml(clean) + '</code><br><br>' + escapeHtml(String(e.message || e)) }));
      setTitle(NAME);
    }
  }
  function b64(s) { var bin = atob(s), u = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }

  /* ================================================================= the Markdown renderer */
  function escapeHtml(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function escapeAttr(s) { return escapeHtml(s).replace(/'/g, '&#39;'); }

  // Only http(s), mailto and relative links are allowed as hrefs; javascript: and data: are dropped.
  function safeUrl(u) {
    u = (u || '').trim();
    if (/^\s*javascript:/i.test(u)) return '#';
    if (/^\s*data:/i.test(u) && !/^data:image\//i.test(u)) return '#';
    return u;
  }

  /* --- inline: emphasis, code, links, images, autolinks, breaks --- */
  function inline(src) {
    var out = '', i = 0, n = src.length;
    function readUntil(ch, from) { var j = from; while (j < n) { if (src[j] === '\\') { j += 2; continue; } if (src[j] === ch) return j; j++; } return -1; }
    while (i < n) {
      var c = src[i];
      if (c === '\\' && i + 1 < n && /[\\`*_{}\[\]()#+\-.!~>|]/.test(src[i + 1])) { out += escapeHtml(src[i + 1]); i += 2; continue; }
      if (c === '`') {
        // inline code: run of backticks to matching run
        var run = 1; while (src[i + run] === '`') run++;
        var fence = src.substr(i, run), end = src.indexOf(fence, i + run);
        if (end >= 0) { var code = src.slice(i + run, end).replace(/^ +| +$/g, ''); out += '<code>' + escapeHtml(code) + '</code>'; i = end + run; continue; }
      }
      if (c === '!' && src[i + 1] === '[') {
        var mEnd = readUntil(']', i + 2);
        if (mEnd >= 0 && src[mEnd + 1] === '(') {
          var pEnd = readUntil(')', mEnd + 2);
          if (pEnd >= 0) {
            var alt = src.slice(i + 2, mEnd), rest = src.slice(mEnd + 2, pEnd).trim();
            var us = rest.split(/\s+/), url = us.shift(), title = us.join(' ').replace(/^"|"$/g, '');
            out += '<img src="' + escapeAttr(safeUrl(url)) + '" alt="' + escapeAttr(alt) + '"' + (title ? ' title="' + escapeAttr(title) + '"' : '') + '>';
            i = pEnd + 1; continue;
          }
        }
      }
      if (c === '[') {
        var lEnd = readUntil(']', i + 1);
        if (lEnd >= 0 && src[lEnd + 1] === '(') {
          var qEnd = readUntil(')', lEnd + 2);
          if (qEnd >= 0) {
            var txt = src.slice(i + 1, lEnd), inside = src.slice(lEnd + 2, qEnd).trim();
            var parts = inside.split(/\s+/), href = parts.shift(), lt = parts.join(' ').replace(/^"|"$/g, '');
            out += '<a href="' + escapeAttr(safeUrl(href)) + '"' + (lt ? ' title="' + escapeAttr(lt) + '"' : '') + (/^https?:/i.test(href) ? ' data-ext="1"' : '') + '>' + inline(txt) + '</a>';
            i = qEnd + 1; continue;
          }
        }
      }
      // autolink <http...> or bare www/http
      if (c === '<') {
        var gt = src.indexOf('>', i + 1);
        if (gt >= 0) { var inner = src.slice(i + 1, gt); if (/^https?:\/\/|^mailto:|^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(inner)) { var href2 = /@/.test(inner) && !/^mailto:/.test(inner) ? 'mailto:' + inner : inner; out += '<a href="' + escapeAttr(safeUrl(href2)) + '"' + (/^https?:/i.test(href2) ? ' data-ext="1"' : '') + '>' + escapeHtml(inner) + '</a>'; i = gt + 1; continue; } }
        out += '&lt;'; i++; continue;
      }
      if ((c === '*' || c === '_')) {
        // strong (double) then emphasis (single)
        var dbl = src[i] === src[i + 1];
        if (dbl) {
          var mark = c + c, close = src.indexOf(mark, i + 2);
          if (close >= 0) { out += '<strong>' + inline(src.slice(i + 2, close)) + '</strong>'; i = close + 2; continue; }
        } else {
          // emphasis; avoid matching inside words for _
          var close1 = -1, j2 = i + 1;
          while (j2 < n) { if (src[j2] === '\\') { j2 += 2; continue; } if (src[j2] === c) { close1 = j2; break; } j2++; }
          if (close1 >= 0 && close1 > i + 1) { out += '<em>' + inline(src.slice(i + 1, close1)) + '</em>'; i = close1 + 1; continue; }
        }
      }
      if (c === '~' && src[i + 1] === '~') {
        var sEnd = src.indexOf('~~', i + 2);
        if (sEnd >= 0) { out += '<del>' + inline(src.slice(i + 2, sEnd)) + '</del>'; i = sEnd + 2; continue; }
      }
      // hard break: two+ spaces at end of a line, handled by caller via \n; a backslash before newline too
      out += escapeHtml(c); i++;
    }
    // bare autolinks for http(s):// runs not already linked
    out = out.replace(/(^|[\s(])((?:https?:\/\/)[^\s<)]+)(?=[\s).,!?]|$)/g, function (m, pre, url) {
      return pre + '<a href="' + escapeAttr(safeUrl(url)) + '" data-ext="1">' + url + '</a>';
    });
    return out.replace(/ {2,}\n/g, '<br>\n');
  }

  /* --- block level --- */
  function mdToHtml(src) {
    src = src.replace(/\r\n?/g, '\n').replace(/\t/g, '    ');
    var lines = src.split('\n'), i = 0, html = '';

    function peek() { return lines[i]; }
    function blank(s) { return /^\s*$/.test(s); }

    while (i < lines.length) {
      var line = lines[i];

      // fenced code
      var fence = /^(\s*)(`{3,}|~{3,})(.*)$/.exec(line);
      if (fence) {
        var indent = fence[1].length, marker = fence[2][0], len = fence[2].length, lang = fence[3].trim().split(/\s+/)[0];
        var buf = []; i++;
        while (i < lines.length) {
          var cl = new RegExp('^\\s*' + marker + '{' + len + ',}\\s*$');
          if (cl.test(lines[i])) { i++; break; }
          buf.push(lines[i].slice(indent)); i++;
        }
        html += '<pre><code' + (lang ? ' class="language-' + escapeAttr(lang) + '"' : '') + '>' + escapeHtml(buf.join('\n')) + '</code></pre>\n';
        continue;
      }

      // blank
      if (blank(line)) { i++; continue; }

      // ATX heading
      var h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
      if (h) { var lvl = h[1].length; html += '<h' + lvl + '>' + inline(h[2]) + '</h' + lvl + '>\n'; i++; continue; }

      // setext heading (=== or ---) under a paragraph line
      if (i + 1 < lines.length && /^\s*(=+|-+)\s*$/.test(lines[i + 1]) && !blank(line) && !/^\s*[-*+]\s/.test(line) && !/^\s*>/.test(line)) {
        var setext = lines[i + 1].trim()[0] === '=' ? 1 : 2;
        html += '<h' + setext + '>' + inline(line.trim()) + '</h' + setext + '>\n'; i += 2; continue;
      }

      // thematic break
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { html += '<hr>\n'; i++; continue; }

      // blockquote
      if (/^\s*>/.test(line)) {
        var qbuf = [];
        while (i < lines.length && (/^\s*>/.test(lines[i]) || (!blank(lines[i]) && qbuf.length && !/^\s*$/.test(lines[i])))) {
          if (blank(lines[i])) break;
          qbuf.push(lines[i].replace(/^\s*>\s?/, '')); i++;
        }
        html += '<blockquote>\n' + mdToHtml(qbuf.join('\n')) + '</blockquote>\n';
        continue;
      }

      // table (a header row of pipes followed by a separator row)
      if (/\|/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1]) && /-/.test(lines[i + 1])) {
        var head = splitRow(line), sep = splitRow(lines[i + 1]);
        var aligns = sep.map(function (c) { var l = /^:/.test(c.trim()), r = /:$/.test(c.trim()); return l && r ? 'center' : r ? 'right' : l ? 'left' : ''; });
        i += 2; var rows = [];
        while (i < lines.length && /\|/.test(lines[i]) && !blank(lines[i])) { rows.push(splitRow(lines[i])); i++; }
        var t = '<table>\n<thead><tr>';
        head.forEach(function (c, ci) { t += '<th' + (aligns[ci] ? ' style="text-align:' + aligns[ci] + '"' : '') + '>' + inline(c.trim()) + '</th>'; });
        t += '</tr></thead>\n<tbody>';
        rows.forEach(function (r) { t += '<tr>'; for (var ci = 0; ci < head.length; ci++) { var cell = r[ci] === undefined ? '' : r[ci]; t += '<td' + (aligns[ci] ? ' style="text-align:' + aligns[ci] + '"' : '') + '>' + inline(cell.trim()) + '</td>'; } t += '</tr>'; });
        t += '</tbody></table>\n';
        html += t; continue;
      }

      // lists (unordered / ordered / task), with nesting by indent
      if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
        var listRes = parseList(lines, i);
        html += listRes.html; i = listRes.next; continue;
      }

      // paragraph: gather until a blank line or a block starter
      var pbuf = [];
      while (i < lines.length && !blank(lines[i]) &&
             !/^(\s*)(`{3,}|~{3,})/.test(lines[i]) && !/^#{1,6}\s/.test(lines[i]) &&
             !/^\s*>/.test(lines[i]) && !/^\s*([-*_])(\s*\1){2,}\s*$/.test(lines[i]) &&
             !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
        pbuf.push(lines[i]); i++;
      }
      html += '<p>' + inline(pbuf.join('\n')) + '</p>\n';
    }
    return html;
  }

  function splitRow(line) {
    var s = line.trim().replace(/^\|/, '').replace(/\|$/, '');
    var cells = [], cur = '', esc = false;
    for (var k = 0; k < s.length; k++) { var ch = s[k]; if (esc) { cur += ch; esc = false; } else if (ch === '\\') { cur += ch; esc = true; } else if (ch === '|') { cells.push(cur); cur = ''; } else cur += ch; }
    cells.push(cur); return cells;
  }

  // Parse a list starting at index `start`; returns { html, next }. Handles nesting by leading indent.
  function parseList(lines, start) {
    var m0 = /^(\s*)([-*+]|\d+[.)])\s+/.exec(lines[start]);
    var baseIndent = m0[1].length, ordered = /\d/.test(m0[2]);
    var items = [], i = start;
    while (i < lines.length) {
      var m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
      if (!m || m[1].length < baseIndent) break;
      if (m[1].length > baseIndent) break;           // deeper item handled as nested content below
      var content = [m[3]]; i++;
      // gather continuation and nested lines (more indented, or lazy paragraph lines)
      while (i < lines.length && !/^\s*$/.test(lines[i])) {
        var deeper = /^(\s+)/.exec(lines[i]);
        var isNewItem = /^(\s*)([-*+]|\d+[.)])\s+/.exec(lines[i]);
        if (isNewItem && isNewItem[1].length <= baseIndent) break;
        content.push(lines[i].replace(new RegExp('^\\s{0,' + (baseIndent + 2) + '}'), '')); i++;
      }
      // consume one trailing blank line that still belongs to the list
      if (i < lines.length && /^\s*$/.test(lines[i]) && i + 1 < lines.length && /^(\s*)([-*+]|\d+[.)])\s+/.test(lines[i + 1]) && /^(\s*)/.exec(lines[i + 1])[1].length >= baseIndent) i++;
      items.push(content.join('\n'));
    }
    var tag = ordered ? 'ol' : 'ul';
    var out = '<' + tag + (ordered && !/^1[.)]/.test(m0[2]) ? ' start="' + parseInt(m0[2], 10) + '"' : '') + '>\n';
    items.forEach(function (raw) {
      var task = /^\[([ xX])\]\s+/.exec(raw);
      if (task) {
        var checked = task[1].toLowerCase() === 'x';
        out += '<li class="task"><input type="checkbox" disabled' + (checked ? ' checked' : '') + '> ' + renderItem(raw.slice(task[0].length)) + '</li>\n';
      } else {
        out += '<li>' + renderItem(raw) + '</li>\n';
      }
    });
    out += '</' + tag + '>\n';
    return { html: out, next: i };
  }

  // A list item's content: a nested list is rendered as a block; a single line is inline; multi-line is a paragraph.
  function renderItem(raw) {
    var lines = raw.split('\n');
    // find where a nested list or block begins
    var head = [], rest = [];
    var k = 0;
    for (; k < lines.length; k++) { if (/^\s*([-*+]|\d+[.)])\s+/.test(lines[k]) || /^\s*(`{3,}|~{3,})/.test(lines[k]) || /^\s*>/.test(lines[k])) break; head.push(lines[k]); }
    rest = lines.slice(k);
    var h = head.join('\n').trim();
    var htmlHead = h ? inline(h) : '';
    var htmlRest = rest.length ? mdToHtml(rest.join('\n')) : '';
    return htmlHead + (htmlRest ? '\n' + htmlRest : '');
  }

  /* ----------------------------------------------------------------- boot */
  if (CTX.startURI && /^https:/i.test(CTX.startURI) && !/\/$/.test(CTX.startURI.replace(/[?#].*$/, ''))) {
    loadCdmi(CTX.startURI);
  } else {
    showEmpty();
  }
})();
