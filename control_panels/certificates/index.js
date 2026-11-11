/*!
 * control_panels/certificates/index.js — the Certificates control panel.
 *
 * A trust store of public-key certificates, kept in ~/prefs/certs/ (one PEM object per certificate). It is the set of
 * signers the user trusts; a later release will verify an application's signature against these keys before running it
 * (see docs/app-compatibility.md for the version gate this prepares to sit beside). This panel only manages the store:
 *   - lists the certificates in ~/prefs/certs/, each with its type and SHA-256 fingerprint;
 *   - loads a new one, pasted as PEM or chosen from a file (PEM or DER);
 *   - removes one.
 * A trust store holds public material only: a pasted or chosen PRIVATE key is refused. Follows the Apps/Locale control
 * panel conventions -- the platinum palette, a sunken list well and a plain footer, no status bar and no modal -- and
 * the shared cvwm.dark light/dark signal. (English only for now; localizable like the Apps panel later.)
 */
(function () {
  var c = window.CDMI_CONTEXT, D = document;
  var HOME = c.homeURI || null;
  var CERTS = HOME ? HOME + 'prefs/certs/' : null;

  /* ---- CSS: the Apps/Locale control-panel palette and chrome (platinum light / dark) ---- */
  var CSS =
    ':root{--std:#60a0c0;--hi:#c06077;--grey:#bfbfbf;--lt:rgba(255,255,255,.6);--dk:rgba(0,0,0,.55);' +
      '--sans:Helvetica,"Nimbus Sans","Liberation Sans",Arial,sans-serif;--mono:"DejaVu Sans Mono","Liberation Mono",Menlo,Consolas,monospace;' +
      '--fg:#000;--dim:#555;--field:#fff;--sel:#000080;--band:#eef3f7;--rowline:rgba(128,128,128,.16);--ok:#1a7f37;--err:#a01722}' +
    'body.dark{--grey:#333b41;--lt:rgba(255,255,255,.16);--dk:rgba(0,0,0,.6);--fg:#e8edf1;--dim:#8a929a;--field:#15191c;--sel:#3a6ea5;--band:#222c35;--rowline:rgba(255,255,255,.08);--ok:#7ec98f;--err:#ff8a8a}' +
    'html,body{margin:0;height:100%}*{box-sizing:border-box}' +
    'body{background:var(--grey);color:var(--fg);font:13px/1.3 var(--sans);display:flex;flex-direction:column;overflow:hidden;-webkit-user-select:none;user-select:none}' +
    'h4{margin:0;font:700 13px var(--sans);color:var(--fg);padding:10px 12px 6px}' +
    '.scroll{flex:1;min-height:0;overflow:auto;background:var(--field);margin:0 10px 8px;border:2px solid;border-color:var(--dk) var(--lt) var(--lt) var(--dk)}' +
    /* cert rows */
    '.cert{display:flex;align-items:flex-start;gap:8px;padding:7px 10px;border-bottom:1px solid var(--rowline)}' +
    '.cert .ic{flex:none;color:var(--dim);width:20px;height:20px;display:flex;align-items:center;justify-content:center}.cert .ic svg{display:block}' +
    '.cert .body{flex:1;min-width:0}' +
    '.cert .nm{font:600 13px var(--sans);word-break:break-all}' +
    '.cert .meta{font:11px var(--sans);color:var(--dim);margin-top:1px}' +
    '.cert .meta .kind{color:var(--fg)}' +
    '.cert .fp{font:11px var(--mono);color:var(--fg);margin-top:3px;word-break:break-all}.cert .fp .k{color:var(--dim)}' +
    '.empty{color:var(--dim);font:12px var(--sans);padding:12px}' +
    /* add form (shown in place of the list) */
    '.form{padding:10px 12px}.form .f{margin:0 0 9px}.form label{display:block;font:11px var(--sans);color:var(--dim);margin:0 0 3px}' +
    '.form input[type=text]{width:100%;height:24px;font:13px var(--mono);padding:0 6px;background:var(--field);color:var(--fg);border:2px solid;border-color:var(--dk) var(--lt) var(--lt) var(--dk)}' +
    '.form textarea{width:100%;height:150px;resize:vertical;font:12px var(--mono);padding:6px;background:var(--field);color:var(--fg);border:2px solid;border-color:var(--dk) var(--lt) var(--lt) var(--dk);white-space:pre;overflow:auto}' +
    '.form input:focus,.form textarea:focus{outline:1px solid var(--fg)}' +
    '.form .row{display:flex;align-items:center;gap:8px}.form .hint{color:var(--dim);font:12px var(--sans)}' +
    /* footer (Apps panel convention: action buttons, no status bar) */
    '.foot{flex:none;display:flex;gap:7px;align-items:center;padding:8px 12px;border-top:1px solid var(--lt)}' +
    '.foot .msg{flex:1;min-width:0;font:12px var(--sans);color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.foot .msg.ok{color:var(--ok)}.foot .msg.err{color:var(--err)}' +
    'button.btn{height:26px;padding:0 12px;background:var(--grey);font:600 12px var(--sans);color:var(--fg);border:2px solid;border-color:var(--lt) var(--dk) var(--dk) var(--lt)}' +
    'button.btn:active:not(:disabled){border-color:var(--dk) var(--lt) var(--lt) var(--dk)}button.btn:disabled{color:var(--dim)}';
  D.head.appendChild(mk('style', { text: CSS }));

  function mk(tag, a, kids) { var e = D.createElement(tag); a = a || {}; for (var k in a) { if (k === 'text') e.textContent = a[k]; else if (k === 'html') e.innerHTML = a[k]; else e.setAttribute(k, a[k]); } (kids || []).forEach(function (n) { if (n) e.appendChild(n); }); return e; }
  function icon() { return '<svg width="20" height="20" viewBox="0 0 22 22" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="8.5" r="4.2"/><path d="M8 12.7V20l2-1.6 2 1.6v-5.1" stroke-linejoin="round"/><path d="M11.5 8.5h7M11.5 6h5M11.5 11h4" stroke-linecap="round"/></svg>'; }

  /* ---- CDMI access (same shape the Apps panel uses) ---- */
  function headers(extra) { var h = {}; var ch = c.headers || {}; for (var k in ch) h[k] = ch[k]; if (extra) for (var j in extra) h[j] = extra[j]; return h; }
  function b64text(s) { try { return decodeURIComponent(escape(atob(String(s).replace(/\s+/g, '')))); } catch (e) { try { return atob(s); } catch (_) { return ''; } } }
  async function ensureCertsDir() {
    var probe = await fetch(CERTS + '?objectType', { headers: headers({ Accept: 'application/cdmi-container' }) });
    if (probe.status === 404) {
      var r = await fetch(CERTS, { method: 'PUT', headers: headers({ 'Content-Type': 'application/cdmi-container', Accept: 'application/cdmi-container' }), body: JSON.stringify({ metadata: {} }) });
      if (!r.ok) throw new Error('create certs/ returned ' + r.status);
    }
  }
  async function listNames() {
    var res = await fetch(CERTS + '?children', { headers: headers({ Accept: 'application/cdmi-container' }) });
    if (res.status === 404) return [];
    if (!res.ok) throw new Error(String(res.status));
    var rep = await res.json(), kids = rep.children || [];
    return kids.map(function (n) { return String(n); }).filter(function (n) { return n && !/\/$/.test(n); });
  }
  async function readText(name) {
    var res = await fetch(CERTS + encodeURIComponent(name) + '?value', { headers: headers({ Accept: 'application/cdmi-object' }) });
    if (!res.ok) throw new Error(String(res.status));
    var rep = await res.json(), raw = rep.value || '';
    return rep.valuetransferencoding === 'base64' ? b64text(raw) : raw;
  }
  async function writeCert(name, pem) {
    var r = await fetch(CERTS + encodeURIComponent(name), { method: 'PUT', headers: headers({ 'Content-Type': 'application/cdmi-object', Accept: 'application/cdmi-object' }),
      body: JSON.stringify({ mimetype: 'application/x-pem-file', metadata: {}, valuetransferencoding: 'utf-8', value: pem }) });
    if (!r.ok) throw new Error('save returned ' + r.status);
  }
  async function removeCert(name) {
    var r = await fetch(CERTS + encodeURIComponent(name), { method: 'DELETE', headers: headers({}) });
    if (!r.ok && r.status !== 404) throw new Error('delete returned ' + r.status);
  }

  /* ---- PEM / DER / fingerprint ---- */
  function pemBlocks(text) {
    // Permissive: capture everything between BEGIN/END and clean it, so RFC-1421 header lines (Key: value) and odd
    // wrapping do not defeat the match. The body is stripped to base64 by b64bytes.
    var re = /-----BEGIN ([A-Za-z0-9 ]+?)-----([\s\S]*?)-----END \1-----/g, m, out = [];
    while ((m = re.exec(text))) {
      var body = m[2].split(/\r?\n/).filter(function (l) { return l.indexOf(':') < 0; }).join('');   // drop PEM header lines
      out.push({ label: m[1].trim(), b64: body });
    }
    return out;
  }
  // Tolerant base64 -> bytes: accept base64url, ignore any stray character, and re-pad. A valid certificate's body is
  // never rejected over padding or a wrapped character (the strict atob was the bug behind "PEM body is not valid base64").
  function b64bytes(b64) {
    var s = String(b64).replace(/[^A-Za-z0-9+/_=-]/g, '').replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
    while (s.length % 4) s += '=';
    var bin = atob(s), a = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return a;
  }
  function derToPem(bytes, label) {
    var bin = ''; for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    var b64 = btoa(bin).replace(/.{1,64}/g, function (s) { return s + '\n'; });
    return '-----BEGIN ' + label + '-----\n' + b64 + '-----END ' + label + '-----\n';
  }
  async function sha256hex(bytes) {
    var h = await crypto.subtle.digest('SHA-256', bytes), a = new Uint8Array(h), s = [];
    for (var i = 0; i < a.length; i++) s.push(('0' + a[i].toString(16)).slice(-2));
    return s.join(':').toUpperCase();
  }
  function kindOf(label) {
    if (/PRIVATE KEY/.test(label)) return 'private key';
    if (/CERTIFICATE REQUEST/.test(label)) return 'certificate request';
    if (/CERTIFICATE/.test(label)) return 'certificate';
    if (/PUBLIC KEY/.test(label)) return 'public key';
    return label.toLowerCase();
  }

  /* ---- a minimal DER/ASN.1 reader, enough to read a certificate's Subject CN ---- */
  function derReader(bytes) {
    var pos = 0;
    return { done: function () { return pos >= bytes.length; },
      tlv: function () { var tag = bytes[pos++], len = bytes[pos++];
        if (len & 0x80) { var n = len & 0x7f, l = 0; while (n-- > 0) l = l * 256 + bytes[pos++]; len = l; }
        var start = pos; pos += len; return { tag: tag, content: bytes.subarray(start, start + len) }; } };
  }
  function derStr(tlv) {
    if (tlv.tag === 0x1e) { var o = ''; for (var i = 0; i + 1 < tlv.content.length; i += 2) o += String.fromCharCode((tlv.content[i] << 8) | tlv.content[i + 1]); return o; }   // BMPString (UTF-16BE)
    try { return new TextDecoder().decode(tlv.content); } catch (e) { var s = ''; for (var j = 0; j < tlv.content.length; j++) s += String.fromCharCode(tlv.content[j]); return s; }
  }
  function cnOfName(nameTLV) {   // Name ::= SEQUENCE OF RDN (SET OF AttributeTypeAndValue); CN OID = 2.5.4.3 => 55 04 03
    var r = derReader(nameTLV.content);
    while (!r.done()) { var set = r.tlv(), sr = derReader(set.content);
      while (!sr.done()) { var atv = sr.tlv(), ar = derReader(atv.content), oid = ar.tlv(), val = ar.tlv();
        if (oid.content.length === 3 && oid.content[0] === 0x55 && oid.content[1] === 0x04 && oid.content[2] === 0x03) return derStr(val).trim();
      } }
    return null;
  }
  function certSubjectCN(der) {
    try {
      var cert = derReader(der).tlv();                        // Certificate SEQUENCE
      var tbs = derReader(cert.content).tlv();                // tbsCertificate SEQUENCE
      var f = derReader(tbs.content), fields = []; while (!f.done()) fields.push(f.tlv());
      var subj = fields[0].tag === 0xA0 ? fields[5] : fields[4];   // skip optional [0] EXPLICIT version; subject is the 2nd Name
      return subj ? cnOfName(subj) : null;
    } catch (e) { return null; }
  }

  function validatePem(text) {
    var blocks = pemBlocks(text);
    if (!blocks.length) throw new Error('No PEM block found. Paste a certificate or public key between -----BEGIN----- and -----END----- lines.');
    for (var i = 0; i < blocks.length; i++) {
      if (/PRIVATE KEY/.test(blocks[i].label)) throw new Error('That is a private key. A trust store holds public certificates and keys only — never load a private key here.');
      if (!b64bytes(blocks[i].b64).length) throw new Error('A PEM block is empty or could not be decoded.');
    }
    var usable = blocks.filter(function (b) { return kindOf(b.label) === 'certificate' || kindOf(b.label) === 'public key'; });
    if (!usable.length) throw new Error('No certificate or public key found (saw: ' + blocks.map(function (b) { return b.label; }).join(', ') + ').');
    return { blocks: blocks, usable: usable };
  }

  function setMsg(text, cls) { msg.textContent = text || ''; msg.className = 'msg' + (cls ? ' ' + cls : ''); }

  /* ---- list view ---- */
  async function refresh() {
    showList();
    listEl.textContent = '';
    var names;
    try { names = await listNames(); } catch (e) { setMsg('Could not read ~/prefs/certs/: ' + e.message, 'err'); return; }
    names.sort(function (a, b) { return a.toLowerCase() < b.toLowerCase() ? -1 : 1; });
    curNames = names.slice();
    if (!names.length) { listEl.appendChild(mk('div', { class: 'empty', text: 'No trusted certificates yet. Use “Load certificate…” to add one.' })); setMsg(''); return; }
    setMsg(names.length === 1 ? '1 certificate' : names.length + ' certificates');
    for (var i = 0; i < names.length; i++) await addRow(names[i]);
  }
  async function addRow(name) {
    var nmEl = mk('div', { class: 'nm', text: name, title: name });   // the certificate's CN, once read; the stored file name until then
    var meta = mk('div', { class: 'meta', text: 'reading…' }), fp = mk('div', { class: 'fp' });
    var rm = mk('button', { class: 'btn', type: 'button', title: 'Remove this certificate from the trust store', text: 'Remove' });
    rm.addEventListener('click', function () {
      rm.disabled = true;
      removeCert(name).then(function () { setMsg('Removed ' + name, 'ok'); refresh(); })
        .catch(function (e) { rm.disabled = false; setMsg('Remove failed: ' + e.message, 'err'); });
    });
    listEl.appendChild(mk('div', { class: 'cert' }, [mk('span', { class: 'ic', html: icon() }), mk('div', { class: 'body' }, [nmEl, meta, fp]), rm]));
    try {
      var pem = await readText(name), blocks = pemBlocks(pem);
      if (!blocks.length) { meta.textContent = 'not a PEM certificate'; return; }
      var b0 = blocks[0], der = b64bytes(b0.b64);
      var cn = kindOf(b0.label) === 'certificate' ? certSubjectCN(der) : null;
      if (cn) nmEl.textContent = cn;
      meta.innerHTML = ''; meta.appendChild(mk('span', { class: 'kind', text: kindOf(b0.label) }));
      meta.appendChild(mk('span', { text: ' · ' + der.length + ' bytes' + (blocks.length > 1 ? ' · +' + (blocks.length - 1) + ' more' : '') }));
      var hex = await sha256hex(der);
      fp.innerHTML = ''; fp.appendChild(mk('span', { class: 'k', text: 'SHA-256  ' })); fp.appendChild(mk('span', { text: hex }));
    } catch (e) { meta.textContent = 'could not read: ' + e.message; }
  }

  /* ---- add view (inline, in place of the list; no modal) ---- */
  function slug(s) { return String(s).trim().replace(/[\/\\?%*:|"<>]+/g, '_').replace(/\s+/g, '-'); }
  function openAdd() { pemTa.value = ''; setMsg(''); showForm(); pemTa.focus(); }
  function onFile(file) {
    var fr = new FileReader();
    fr.onload = function () {
      var buf = new Uint8Array(fr.result), txt = '';
      for (var i = 0; i < buf.length; i++) txt += String.fromCharCode(buf[i]);
      pemTa.value = /-----BEGIN /.test(txt) ? txt : derToPem(buf, 'CERTIFICATE');   // a raw .der/.cer is wrapped as a certificate
      setMsg('');
    };
    fr.readAsArrayBuffer(file);
  }
  function doAdd() {
    var text = pemTa.value, info;
    try { info = validatePem(text); } catch (e) { setMsg(e.message, 'err'); return; }
    // The entry is named by the certificate's Subject CN. A bare public key has no CN, so it falls back to its kind
    // plus a short fingerprint. The stored file keeps the .pem extension.
    var cert = info.usable.filter(function (b) { return kindOf(b.label) === 'certificate'; })[0] || info.usable[0];
    var der = b64bytes(cert.b64);
    var cn = kindOf(cert.label) === 'certificate' ? certSubjectCN(der) : null;
    okBtn.disabled = true;
    sha256hex(der).then(function (hex) {
      var fp8 = hex.replace(/:/g, '').slice(0, 8).toLowerCase();
      var base = (cn && slug(cn)) || (kindOf(cert.label).replace(/\s+/g, '-') + '-' + fp8);
      var name = base + '.pem';
      if (curNames.indexOf(name) >= 0) name = base + '-' + fp8 + '.pem';   // don't overwrite a different entry already using this name
      return writeCert(name, text.replace(/\r\n/g, '\n').replace(/\s*$/, '') + '\n').then(function () {
        okBtn.disabled = false; setMsg('Loaded ' + (cn ? ('“' + cn + '”') : name), 'ok'); refresh();
      });
    }).catch(function (e) { okBtn.disabled = false; setMsg('Save failed: ' + e.message, 'err'); });
  }

  /* ---- build ---- */
  var curNames = [];
  var header = mk('h4', { text: 'Trusted certificates' });
  var listEl = mk('div', { class: 'scroll' });
  var pemTa = mk('textarea', { spellcheck: 'false', placeholder: '-----BEGIN CERTIFICATE-----\n…\n-----END CERTIFICATE-----' });
  var fileIn = mk('input', { type: 'file', accept: '.pem,.crt,.cer,.der,.pub', style: 'display:none' });
  var fileBtn = mk('button', { class: 'btn', type: 'button', text: 'Choose file…' });
  var formEl = mk('div', { class: 'scroll' }, [mk('div', { class: 'form' }, [
    mk('div', { class: 'f' }, [mk('label', { text: 'Certificate or public key (PEM)' }), pemTa]),
    mk('div', { class: 'row' }, [fileBtn, mk('span', { class: 'hint', text: 'Paste PEM above, or choose a .pem / .crt / .der file. The name comes from the certificate’s CN.' })]),
    fileIn
  ])]);
  formEl.style.display = 'none';

  var loadBtn = mk('button', { class: 'btn', type: 'button', text: 'Load certificate…' });   // list mode
  var okBtn = mk('button', { class: 'btn', type: 'button', text: 'Load' });                    // form mode
  var cancelBtn = mk('button', { class: 'btn', type: 'button', text: 'Cancel' });              // form mode
  var msg = mk('span', { class: 'msg' });
  var foot = mk('div', { class: 'foot' });

  function showList() { formEl.style.display = 'none'; listEl.style.display = ''; header.textContent = 'Trusted certificates'; foot.textContent = ''; foot.appendChild(loadBtn); foot.appendChild(msg); }
  function showForm() { listEl.style.display = 'none'; formEl.style.display = ''; header.textContent = 'Load a trusted certificate'; foot.textContent = ''; foot.appendChild(cancelBtn); foot.appendChild(okBtn); foot.appendChild(msg); }

  D.body.appendChild(header);
  D.body.appendChild(listEl);
  D.body.appendChild(formEl);
  D.body.appendChild(foot);
  showList();

  loadBtn.addEventListener('click', openAdd);
  cancelBtn.addEventListener('click', refresh);
  okBtn.addEventListener('click', doAdd);
  fileBtn.addEventListener('click', function () { fileIn.value = ''; fileIn.click(); });
  fileIn.addEventListener('change', function () { if (fileIn.files && fileIn.files[0]) onFile(fileIn.files[0]); });

  /* ---- dark mode ---- */
  function setDark(on) { D.body.classList.toggle('dark', !!on); }
  try { setDark(localStorage.getItem('cvwm.dark') === 'on'); } catch (e) {}
  window.addEventListener('storage', function (ev) { if (ev.key === 'cvwm.dark') setDark(ev.newValue === 'on'); });

  /* ---- boot ---- */
  if (c.setTitle) c.setTitle('Certificates');
  if (c.resize) c.resize(600, 460);
  if (!HOME) { listEl.appendChild(mk('div', { class: 'empty', text: 'Sign in to manage trusted certificates.' })); loadBtn.disabled = true; }
  else ensureCertsDir().then(refresh).catch(function (e) { setMsg('Cannot open ~/prefs/certs/: ' + e.message, 'err'); });
})();
