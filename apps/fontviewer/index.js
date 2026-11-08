/*!
 * apps/fontviewer/index.js — view a font file.
 *
 * Opened with a font object as its start (a .ttf/.otf/.woff/.woff2, routed here by the desktop on a double-click, as
 * PDFs go to pdfviewer). It loads the bytes with the FontFace API and shows, in one scrolling split view:
 *   - a SAMPLE: a large, editable multi-line text box rendered in the font, with a numeric point size;
 *   - the CHARACTERS: a Unicode viewer -- the font's own repertoire, grouped by block, with a detail for the glyph.
 * The title bar and status bar carry the font's family, style, glyph count and format. Light and dark follow the
 * shared cvwm.dark signal, like the other cvwm applications.
 *
 * The repertoire comes from the font's cmap table (parsed here for sfnt -- TTF/OTF -- and WOFF, whose tables are
 * zlib-compressed); for WOFF2 (Brotli, which the browser decodes but this does not) it falls back to probing each
 * code point of the chosen block on a canvas. Family/style come from the name table, glyph count from maxp.
 */
(function () {
  var c = window.CDMI_CONTEXT, D = document;
  var FAM = 'fvpreview';                                  // the FontFace family the specimen renders in
  var SAMPLE = 'The quick brown fox jumps over the lazy dog\n' +
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ\nabcdefghijklmnopqrstuvwxyz\n0123456789  .,:;!?  @#$%&*()[]{}/';
  var DEFAULT_SIZE = 36;

  /* ---- a compact Unicode block table (common blocks) ---- */
  var BLOCKS = [
    ['Basic Latin', 0x0, 0x7F], ['Latin-1 Supplement', 0x80, 0xFF], ['Latin Extended-A', 0x100, 0x17F],
    ['Latin Extended-B', 0x180, 0x24F], ['IPA Extensions', 0x250, 0x2AF], ['Spacing Modifiers', 0x2B0, 0x2FF],
    ['Combining Diacritics', 0x300, 0x36F], ['Greek and Coptic', 0x370, 0x3FF], ['Cyrillic', 0x400, 0x4FF],
    ['Cyrillic Supplement', 0x500, 0x52F], ['Armenian', 0x530, 0x58F], ['Hebrew', 0x590, 0x5FF],
    ['Arabic', 0x600, 0x6FF], ['Devanagari', 0x900, 0x97F], ['Bengali', 0x980, 0x9FF], ['Thai', 0xE00, 0xE7F],
    ['Georgian', 0x10A0, 0x10FF], ['Hangul Jamo', 0x1100, 0x11FF], ['Latin Extended Additional', 0x1E00, 0x1EFF],
    ['Greek Extended', 0x1F00, 0x1FFF], ['General Punctuation', 0x2000, 0x206F], ['Superscripts & Subscripts', 0x2070, 0x209F],
    ['Currency Symbols', 0x20A0, 0x20CF], ['Letterlike Symbols', 0x2100, 0x214F], ['Number Forms', 0x2150, 0x218F],
    ['Arrows', 0x2190, 0x21FF], ['Mathematical Operators', 0x2200, 0x22FF], ['Misc. Technical', 0x2300, 0x23FF],
    ['Box Drawing', 0x2500, 0x257F], ['Block Elements', 0x2580, 0x259F], ['Geometric Shapes', 0x25A0, 0x25FF],
    ['Misc. Symbols', 0x2600, 0x26FF], ['Dingbats', 0x2700, 0x27BF], ['CJK Symbols & Punctuation', 0x3000, 0x303F],
    ['Hiragana', 0x3040, 0x309F], ['Katakana', 0x30A0, 0x30FF], ['CJK Unified Ideographs', 0x4E00, 0x9FFF],
    ['Hangul Syllables', 0xAC00, 0xD7A3], ['Private Use Area', 0xE000, 0xF8FF], ['Alphabetic Presentation', 0xFB00, 0xFB4F],
    ['Emoticons', 0x1F600, 0x1F64F], ['Misc. Symbols & Pictographs', 0x1F300, 0x1F5FF]
  ];

  /* ---- font parsing (sfnt + WOFF) ---------------------------------------------------------------- */
  function tag(dv, o) { return String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3)); }
  async function inflateZlib(u8) {
    if (typeof DecompressionStream === 'undefined') throw new Error('no DecompressionStream');
    var ds = new DecompressionStream('deflate');
    return new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(ds)).arrayBuffer());
  }

  // Return { getTable(tag)->DataView|null, format } for an sfnt or WOFF buffer. WOFF2 returns getTable()=>null.
  async function openSfnt(bytes) {
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), magic = dv.getUint32(0), tags = {};
    var fmt = magic === 0x4F54544F ? 'OpenType (CFF)' : (magic === 0x00010000 || magic === 0x74727565) ? 'TrueType'
      : magic === 0x774F4646 ? 'WOFF' : magic === 0x774F4632 ? 'WOFF2' : 'font';
    if (magic === 0x774F4632) return { getTable: function () { return null; }, format: 'WOFF2' };        // Brotli: not parsed here
    if (magic === 0x774F4646) {                                                                           // WOFF: a directory of (maybe) zlib tables
      var num = dv.getUint16(12), p = 44, dirs = [];
      for (var i = 0; i < num; i++) { dirs.push({ tag: tag(dv, p), off: dv.getUint32(p + 4), comp: dv.getUint32(p + 8), orig: dv.getUint32(p + 12) }); p += 20; }
      for (var j = 0; j < dirs.length; j++) {
        var d = dirs[j], raw = bytes.subarray(d.off, d.off + d.comp);
        var data = d.comp < d.orig ? await inflateZlib(raw) : raw.slice();
        tags[d.tag] = new DataView(data.buffer, data.byteOffset, data.byteLength);
      }
      return { getTable: function (t) { return tags[t] || null; }, format: 'WOFF' };
    }
    var n = dv.getUint16(4), q = 12;                                                                      // plain sfnt
    for (var k = 0; k < n; k++) { tags[tag(dv, q)] = { off: dv.getUint32(q + 8), len: dv.getUint32(q + 12) }; q += 16; }
    return { getTable: function (t) { var e = tags[t]; return e ? new DataView(bytes.buffer, bytes.byteOffset + e.off, e.len) : null; }, format: fmt };
  }

  function decodeName(dv, o, len, utf16) {
    var s = '';
    if (utf16) { for (var i = 0; i < len; i += 2) s += String.fromCharCode(dv.getUint16(o + i)); }
    else { for (var j = 0; j < len; j++) s += String.fromCharCode(dv.getUint8(o + j)); }
    return s;
  }
  function parseName(dv) {                                                                                // -> {1:family, 2:subfamily, ...} best strings
    if (!dv) return {};
    var count = dv.getUint16(2), strOff = dv.getUint16(4), out = {}, best = {};
    for (var i = 0; i < count; i++) {
      var r = 6 + i * 12, pid = dv.getUint16(r), lid = dv.getUint16(r + 4), nid = dv.getUint16(r + 6), len = dv.getUint16(r + 8), off = dv.getUint16(r + 10);
      var utf16 = pid === 3 || pid === 0, score = (pid === 3 && lid === 0x409) ? 3 : pid === 3 ? 2 : pid === 0 ? 1 : 0;
      if (best[nid] === undefined || score > best[nid]) { try { out[nid] = decodeName(dv, strOff + off, len, utf16); best[nid] = score; } catch (e) {} }
    }
    return out;
  }
  function parseMaxp(dv) { return dv ? dv.getUint16(4) : null; }

  // Parse cmap (format 4 and 12) into a sorted array of [start,end] ranges of supported code points, or null.
  function parseCmap(dv) {
    if (!dv) return null;
    var num = dv.getUint16(2), best = -1, bestScore = -1;
    for (var i = 0; i < num; i++) {
      var r = 4 + i * 8, pid = dv.getUint16(r), eid = dv.getUint16(r + 2), off = dv.getUint32(r + 4);
      var sc = (pid === 3 && eid === 10) ? 5 : (pid === 0 && eid >= 4) ? 4 : (pid === 3 && eid === 1) ? 3 : (pid === 0) ? 2 : (pid === 3 && eid === 0) ? 1 : 0;
      if (sc > bestScore) { bestScore = sc; best = off; }
    }
    if (best < 0) return null;
    var fmt = dv.getUint16(best), ranges = [];
    if (fmt === 4) {
      var segX2 = dv.getUint16(best + 6), seg = segX2 / 2;
      var endO = best + 14, startO = endO + segX2 + 2, deltaO = startO + segX2, rangeO = deltaO + segX2;
      for (var s = 0; s < seg; s++) {
        var end = dv.getUint16(endO + s * 2), st = dv.getUint16(startO + s * 2), delta = dv.getUint16(deltaO + s * 2), ro = dv.getUint16(rangeO + s * 2);
        if (st === 0xFFFF) continue;
        var cur = -1, lo = -1;
        for (var ch = st; ch <= end && ch !== 0xFFFF; ch++) {
          var g;
          if (ro === 0) g = (ch + delta) & 0xFFFF;
          else { var a = rangeO + s * 2 + ro + (ch - st) * 2; if (a + 1 >= dv.byteLength) { g = 0; } else { g = dv.getUint16(a); if (g !== 0) g = (g + delta) & 0xFFFF; } }
          if (g !== 0) { if (lo < 0) lo = ch; cur = ch; } else if (lo >= 0) { ranges.push([lo, cur]); lo = -1; }
        }
        if (lo >= 0) ranges.push([lo, cur]);
      }
    } else if (fmt === 12) {
      var nG = dv.getUint32(best + 12);
      for (var gI = 0; gI < nG; gI++) { var go = best + 16 + gI * 12; ranges.push([dv.getUint32(go), dv.getUint32(go + 4)]); }
    } else return null;
    ranges.sort(function (a, b) { return a[0] - b[0]; });
    return ranges;
  }
  function inRanges(ranges, cp) { for (var i = 0; i < ranges.length; i++) { if (cp < ranges[i][0]) return false; if (cp <= ranges[i][1]) return true; } return false; }
  function blockHas(ranges, b) { for (var i = 0; i < ranges.length; i++) { if (ranges[i][1] >= b[1] && ranges[i][0] <= b[2]) return true; } return false; }

  /* ---- canvas probe (WOFF2 / cmap missing): is a code point drawn by the font? ---- */
  var pc = D.createElement('canvas'); pc.width = pc.height = 28; var pcx = pc.getContext('2d'); var notdefKey = null;
  function renderKey(cp) {
    pcx.clearRect(0, 0, 28, 28); pcx.fillStyle = '#000'; pcx.font = '22px ' + FAM; pcx.textBaseline = 'top';
    try { pcx.fillText(String.fromCodePoint(cp), 2, 2); } catch (e) {}
    return pc.toDataURL();
  }
  function probeSupported(cp) {
    if (notdefKey === null) notdefKey = renderKey(0x10FFFD);          // a code point essentially no font maps -> its .notdef/blank
    var k = renderKey(cp); return k !== notdefKey;
  }

  /* ---- CSS ------------------------------------------------------------------------------------- */
  var CSS =
    ':root{--std:#60a0c0;--hi:#c06077;--grey:#bfbfbf;--lt:rgba(255,255,255,.6);--dk:rgba(0,0,0,.55);' +
      '--sans:Helvetica,"Nimbus Sans","Liberation Sans",Arial,sans-serif;--mono:"DejaVu Sans Mono",monospace;' +
      '--fg:#000;--dim:#555;--field:#fff;--sel:#000080}' +
    'body.dark{--grey:#333b41;--lt:rgba(255,255,255,.16);--dk:rgba(0,0,0,.6);--fg:#e8edf1;--dim:#8a929a;--field:#15191c;--sel:#3a6ea5}' +
    'html,body{margin:0;height:100%}' +
    'body{background:var(--grey);color:var(--fg);font:13px/1.3 var(--sans);display:flex;flex-direction:column;-webkit-user-select:none;user-select:none}' +
    '*{box-sizing:border-box}' +
    '#view{flex:1;min-height:0;overflow:auto;padding:12px 14px;display:flex;flex-direction:column}' +
    '.hdr{display:flex;align-items:center;gap:10px;margin:14px 0 7px}.hdr:first-child{margin-top:0}.hdr h4{margin:0}.hdr .sp{flex:1}' +
    'h4{font:700 11px var(--sans);letter-spacing:.04em;text-transform:uppercase;color:var(--dim)}' +
    '.szctl{display:flex;align-items:center;gap:6px;font:12px var(--sans);color:var(--fg)}' +
    '.szctl input{width:56px;height:24px;padding:0 6px;background:var(--field);color:var(--fg);font:13px var(--mono);text-align:right;border:2px solid;border-color:var(--dk) var(--lt) var(--lt) var(--dk)}' +
    '#sample{flex:none;height:180px;min-height:90px;width:100%;resize:vertical;padding:8px 10px;background:var(--field);color:var(--fg);' +
      'font-family:' + FAM + ';line-height:1.18;border:2px solid;border-color:var(--dk) var(--lt) var(--lt) var(--dk);overflow:auto;white-space:pre-wrap;-webkit-user-select:text;user-select:text}' +
    '.chd select{height:24px;background:var(--field);color:var(--fg);font:12px var(--sans);border:2px solid;border-color:var(--dk) var(--lt) var(--lt) var(--dk);padding:0 6px}' +
    '.chd span{font:11px var(--sans);color:var(--dim)}' +
    '#grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(34px,1fr));gap:2px;background:var(--field);border:2px solid;border-color:var(--dk) var(--lt) var(--lt) var(--dk);padding:3px}' +
    '.cell{aspect-ratio:1;display:flex;align-items:center;justify-content:center;font-family:' + FAM + ';font-size:20px;color:var(--fg);cursor:pointer;overflow:hidden}' +
    '.cell:hover{background:rgba(128,128,128,.22)}.cell.sel{background:var(--sel);color:#fff}' +
    '.empty{color:var(--dim);font:12px var(--sans);padding:10px}' +
    '#status{height:24px;flex:none;display:flex;align-items:center;gap:14px;padding:0 10px;background:var(--grey);color:var(--fg);font:11px var(--mono);border-top:1px solid var(--lt);white-space:nowrap;overflow:hidden}' +
    '#status .meta{display:flex;align-items:center;gap:14px;min-width:0;overflow:hidden}' +
    '#status b{font-weight:700}#status .r{margin-left:auto;color:var(--dim)}';
  D.head.appendChild(el('style', { text: CSS }));

  function el(t, a, kids) { var e = D.createElement(t); a = a || {}; for (var k in a) { if (k === 'text') e.textContent = a[k]; else e.setAttribute(k, a[k]); } (kids || []).forEach(function (n) { if (n) e.appendChild(n); }); return e; }

  /* ---- DOM ---- */
  var sizeIn = el('input', { type: 'number', min: '6', max: '400', step: '1', value: String(DEFAULT_SIZE), 'aria-label': 'Sample size' });
  var szctl = el('label', { class: 'szctl' }, [el('span', { text: 'Size' }), sizeIn, el('span', { text: 'px' })]);
  var sample = el('textarea', { id: 'sample', spellcheck: 'false', 'aria-label': 'Sample text' });
  sample.value = SAMPLE;
  var blockSel = el('select'), countLbl = el('span', {}), grid = el('div', { id: 'grid' });
  var view = el('div', { id: 'view' }, [
    el('div', { class: 'hdr' }, [el('h4', { text: 'Sample' }), el('span', { class: 'sp' }), szctl]), sample,
    el('div', { class: 'hdr chd' }, [el('h4', { text: 'Characters' }), blockSel, countLbl]), grid]);
  var sMeta = el('span', { class: 'meta' }), sGlyph = el('span', { class: 'r' });
  var status = el('div', { id: 'status' }, [sMeta, sGlyph]);
  D.body.appendChild(view); D.body.appendChild(status);

  var RANGES = null, probe = false;
  function setSampleSize() { var n = Math.max(6, Math.min(400, +sizeIn.value || DEFAULT_SIZE)); sample.style.fontSize = n + 'px'; }
  function fillBlocks() {
    blockSel.textContent = '';
    var usable = BLOCKS.filter(function (b) { return probe || blockHas(RANGES, b); });
    if (!usable.length) usable = BLOCKS;
    usable.forEach(function (b) { blockSel.appendChild(el('option', { value: b[0], text: b[0] + '  (U+' + hex(b[1]) + '–U+' + hex(b[2]) + ')' })); });
    renderGrid();
  }
  function hex(n) { var s = n.toString(16).toUpperCase(); return s.length < 4 ? ('0000' + s).slice(-4) : s; }
  function renderGrid() {
    var b = BLOCKS.filter(function (x) { return x[0] === blockSel.value; })[0] || BLOCKS[0];
    grid.textContent = ''; var shown = 0, cap = 4096;
    for (var cp = b[1]; cp <= b[2] && shown < cap; cp++) {
      var ok = probe ? probeSupported(cp) : inRanges(RANGES, cp);
      if (!ok) continue;
      (function (cp) {
        var cell = el('div', { class: 'cell', title: 'U+' + hex(cp) }, [D.createTextNode(String.fromCodePoint(cp))]);
        cell.addEventListener('click', function () { grid.querySelectorAll('.sel').forEach(function (n) { n.classList.remove('sel'); }); cell.classList.add('sel'); sGlyph.textContent = 'U+' + hex(cp) + '  ‘' + String.fromCodePoint(cp) + '’'; });
        grid.appendChild(cell);
      })(cp); shown++;
    }
    countLbl.textContent = shown ? (shown + (shown === cap ? '+' : '') + ' glyph' + (shown === 1 ? '' : 's')) : '';
    if (!shown) grid.appendChild(el('div', { class: 'empty', text: 'No glyphs in this block.' }));
  }

  sizeIn.addEventListener('input', setSampleSize);
  blockSel.addEventListener('change', renderGrid);

  function setDark(on) { D.body.classList.toggle('dark', !!on); }
  try { setDark(localStorage.getItem('cvwm.dark') === 'on'); } catch (e) {}
  window.addEventListener('storage', function (ev) { if (ev.key === 'cvwm.dark') setDark(ev.newValue === 'on'); });

  function fileName() { var u = (c.startURI || '').split('?')[0].replace(/\/$/, ''); try { return decodeURIComponent(u.split('/').pop()); } catch (e) { return u.split('/').pop(); } }
  function titleFromFile() { return fileName().replace(/\.(ttf|otf|woff2?|ttc)$/i, '').replace(/[_-]+/g, ' '); }

  /* ---- load ---- */
  (async function () {
    setSampleSize();
    if (!c.startURI) { sMeta.textContent = 'No font to show.'; return; }
    var bytes;
    try {
      var res = await fetch(c.startURI + '?value', { headers: Object.assign({ Accept: 'application/cdmi-object' }, c.headers || {}) });
      if (!res.ok) throw new Error(res.status + '');
      var rep = await res.json(), val = rep.value || '';
      if (rep.valuetransferencoding === 'base64') { var bin = atob(val.replace(/\s+/g, '')); bytes = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i); }
      else bytes = new TextEncoder().encode(val);
    } catch (e) { sMeta.textContent = 'Could not read the font: ' + (e && e.message || e); return; }

    try { var face = new FontFace(FAM, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)); await face.load(); D.fonts.add(face); }
    catch (e) { sMeta.textContent = 'This file is not a usable font.'; return; }
    setSampleSize();

    var family = titleFromFile(), style = '', glyphs = null, format = 'font';
    try {
      var sf = await openSfnt(bytes); format = sf.format;
      var nm = parseName(sf.getTable('name'));
      if (nm[1]) family = nm[1]; if (nm[2]) style = nm[2];
      glyphs = parseMaxp(sf.getTable('maxp'));
      RANGES = parseCmap(sf.getTable('cmap'));
    } catch (e) { RANGES = null; }
    if (!RANGES) probe = true;

    if (c.setTitle) c.setTitle(family + (style ? ' — ' + style : ''));
    sMeta.innerHTML = '';
    sMeta.appendChild(el('b', { text: family }));
    [style, glyphs != null ? glyphs + ' glyphs' : null, format].forEach(function (t) { if (t) sMeta.appendChild(el('span', { text: t })); });
    fillBlocks();
  })();

  if (c.resize) c.resize(660, 480);
})();
