/*! unzip [-l] [-d dir] archive.zip [name...] - list, or extract, the entries of a ZIP object into the store. A cvwm command.
 *
 * Reads a PKZIP archive data object and, by default, writes each entry back as a data object (creating the containers
 * its path needs) under the current container or -d dir. -l lists the entries instead. Stored and DEFLATE entries are
 * handled (DEFLATE through the platform's DecompressionStream); ZIP64 and encrypted entries are not. Names that would
 * escape the destination (absolute, or containing "..") are refused.
 */
(function () {
  var c = window.CDMI_CONTEXT, sh = c.shell, o = sh.opts(c.argv.slice(1), { d: 'value' });
  if (!o._.length || c.argv[1] === '--help') { c.stderr('usage: unzip [-l] [-d dir] archive.zip [name...]'); return c.exit(o._.length ? 0 : 2); }
  var archive = o._[0], want = o._.slice(1), list = !!o.l, destArg = o.d || '.';

  function unb64(s) { var bin = atob(String(s).replace(/\s+/g, '')), a = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return a; }
  function b64(bytes) { var s = ''; for (var i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); }
  async function inflateRaw(bytes) {
    if (typeof DecompressionStream === 'undefined') throw new Error('this browser cannot inflate DEFLATE entries');
    var ds = new DecompressionStream('deflate-raw');
    return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(ds)).arrayBuffer());
  }
  var MIME = { txt: 'text/plain', md: 'text/markdown', markdown: 'text/markdown', json: 'application/json', js: 'text/javascript', mjs: 'text/javascript',
    css: 'text/css', html: 'text/html', htm: 'text/html', xml: 'application/xml', csv: 'text/csv', svg: 'image/svg+xml', png: 'image/png',
    jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', pdf: 'application/pdf', zip: 'application/zip', gz: 'application/gzip' };
  function mimeOf(name) { var m = /\.([A-Za-z0-9]+)$/.exec(name); return (m && MIME[m[1].toLowerCase()]) || 'application/octet-stream'; }

  async function parseZip(bytes) {
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), i = bytes.length - 22;
    for (; i >= 0; i--) if (dv.getUint32(i, true) === 0x06054b50) break;
    if (i < 0) throw new Error('not a ZIP file (no end-of-central-directory record)');
    var count = dv.getUint16(i + 10, true), p = dv.getUint32(i + 16, true), entries = [], dec = new TextDecoder('utf-8');
    for (var n = 0; n < count; n++) {
      if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('corrupt central directory');
      var method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true), usize = dv.getUint32(p + 24, true);
      var nlen = dv.getUint16(p + 28, true), elen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true), lho = dv.getUint32(p + 42, true);
      entries.push({ name: dec.decode(bytes.subarray(p + 46, p + 46 + nlen)), method: method, csize: csize, usize: usize, lho: lho });
      p += 46 + nlen + elen + clen;
    }
    return { dv: dv, bytes: bytes, entries: entries };
  }
  async function bytesOfEntry(z, e) {
    if (z.dv.getUint32(e.lho, true) !== 0x04034b50) throw new Error('corrupt local header for ' + e.name);
    var nlen = z.dv.getUint16(e.lho + 26, true), elen = z.dv.getUint16(e.lho + 28, true), start = e.lho + 30 + nlen + elen;
    var comp = z.bytes.subarray(start, start + e.csize);
    if (e.method === 0) return comp.slice();
    if (e.method === 8) return inflateRaw(comp);
    throw new Error('unsupported compression method ' + e.method);
  }

  function safe(name) { return !/^\//.test(name) && name.split('/').indexOf('..') < 0; }
  async function ensureDir(loc) {
    var url = sh.dirURL(loc);
    try { await sh.cdmi(url + '?objectType', sh.ACCEPT_DIR, true); return; }
    catch (e) { if (e.status !== 404 && e.status !== 406) throw e; }
    await sh.cdmi(url, sh.T_CONTAINER, 'PUT', JSON.stringify({ metadata: {} }));
  }

  (async function () {
    try {
      var at = await sh.locate(sh.resolve(archive));
      if (at.dir) throw new Error(archive + ': is a container, not a ZIP object');
      var v = await sh.readValue(at.loc), bytes = v.bytes !== undefined ? v.bytes : new TextEncoder().encode(v.text || '');
      var z = await parseZip(bytes);
      var pick = want.length ? z.entries.filter(function (e) { return want.indexOf(e.name) >= 0; }) : z.entries;
      if (want.length && pick.length !== want.length) c.stderr('unzip: some named entries were not found');

      if (list) {
        c.stdout('\x1b[2m  length  name\x1b[0m');
        pick.forEach(function (e) { c.stdout(('       ' + e.usize).slice(-8) + '  ' + (/\/$/.test(e.name) ? '\x1b[34;1m' + e.name + '\x1b[0m' : e.name)); });
        c.stdout('\x1b[2m  ' + pick.length + ' entr' + (pick.length === 1 ? 'y' : 'ies') + '\x1b[0m');
        return c.exit(0);
      }

      var dest = sh.resolve(destArg); await ensureDir(dest);
      var made = 0, dirs = {};
      for (var i = 0; i < pick.length; i++) {
        var e = pick[i], name = e.name;
        if (!safe(name)) { c.stderr('unzip: ' + name + ': unsafe path, skipped'); continue; }
        var parts = name.split('/').filter(function (s) { return s.length; });
        if (/\/$/.test(name)) {                                   // a directory entry
          var dloc = { ns: dest.ns, segs: dest.segs.concat(parts) }; await ensureDir(dloc); dirs[parts.join('/')] = 1; continue;
        }
        for (var d = 1; d < parts.length; d++) { var key = parts.slice(0, d).join('/'); if (!dirs[key]) { await ensureDir({ ns: dest.ns, segs: dest.segs.concat(parts.slice(0, d)) }); dirs[key] = 1; } }
        var data = await bytesOfEntry(z, e), mime = mimeOf(name), body = { mimetype: mime, metadata: {} }, text = null;
        if (/^text\/|json|xml|javascript|csv|svg/.test(mime)) { try { text = new TextDecoder('utf-8', { fatal: true }).decode(data); } catch (t) { text = null; } }
        if (text !== null) { body.valuetransferencoding = 'utf-8'; body.value = text; }
        else { body.valuetransferencoding = 'base64'; body.value = b64(data); }
        await sh.cdmi(sh.leafURL({ ns: dest.ns, segs: dest.segs.concat(parts) }), sh.T_OBJECT, 'PUT', JSON.stringify(body));
        c.stdout('  ' + name); made++;
      }
      c.stdout('\x1b[32mextracted ' + made + ' file' + (made === 1 ? '' : 's') + ' to ' + sh.show(dest, true) + '\x1b[0m');
      c.exit(0);
    } catch (e) { c.stderr('unzip: ' + (e && e.message || e)); c.exit(1); }
  })();
})();
