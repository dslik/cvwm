/*! zip [-0] [-r] archive.zip path... - pack data objects (and, with -r, containers) into a ZIP object. A cvwm command.
 *
 * Writes a standard PKZIP archive (DEFLATE, or stored with -0) as a new data object `archive.zip` in the store, so it
 * can then be downloaded with the browser (the container browser's Download… item) or deserialized elsewhere. The
 * archive is built in the browser: CRC-32 in JS, compression through the platform's CompressionStream (store is used
 * where it is unavailable). A container is packed only with -r, its objects entered under its own name.
 */
(function () {
  var c = window.CDMI_CONTEXT, sh = c.shell, o = sh.opts(c.argv.slice(1), {});
  if (o._.length < 2 || c.argv[1] === '--help') { c.stderr('usage: zip [-0] [-r] archive.zip path...'); return c.exit(o._.length >= 2 ? 0 : 2); }
  var dest = o._[0], paths = o._.slice(1), store = !!o['0'], recurse = !!o.r;

  function b64(bytes) { var s = ''; for (var i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); }
  var CRC = (function () { var t = new Uint32Array(256); for (var n = 0; n < 256; n++) { var r = n; for (var k = 0; k < 8; k++) r = r & 1 ? 0xEDB88320 ^ (r >>> 1) : r >>> 1; t[n] = r >>> 0; } return t; })();
  function crc32(b) { var r = 0xFFFFFFFF; for (var i = 0; i < b.length; i++) r = CRC[(r ^ b[i]) & 0xFF] ^ (r >>> 8); return (r ^ 0xFFFFFFFF) >>> 0; }
  async function deflateRaw(bytes) {
    if (typeof CompressionStream === 'undefined') return null;
    try { var cs = new CompressionStream('deflate-raw'); return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(cs)).arrayBuffer()); }
    catch (e) { return null; }      // deflate-raw not supported here: fall back to stored
  }
  function dosTime(d) { return ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xFFFF; }
  function dosDate(d) { return (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF; }

  async function makeZip(entries) {
    var now = new Date(), parts = [], central = [], offset = 0, enc = new TextEncoder();
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i], name = enc.encode(e.name), usize = e.bytes.length, crc = crc32(e.bytes), data = e.bytes, method = 0;
      if (!store && usize > 0) { var def = await deflateRaw(e.bytes); if (def && def.length < usize) { data = def; method = 8; } }
      var csize = data.length, lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);   // bit 11: UTF-8 names
      lh.setUint16(8, method, true); lh.setUint16(10, dosTime(now), true); lh.setUint16(12, dosDate(now), true);
      lh.setUint32(14, crc, true); lh.setUint32(18, csize, true); lh.setUint32(22, usize, true);
      lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
      parts.push(new Uint8Array(lh.buffer), name, data);
      central.push({ name: name, crc: crc, csize: csize, usize: usize, method: method, offset: offset, time: dosTime(now), date: dosDate(now) });
      offset += 30 + name.length + csize;
    }
    var cd = [], cdSize = 0;
    central.forEach(function (e) {
      var ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
      ch.setUint16(10, e.method, true); ch.setUint16(12, e.time, true); ch.setUint16(14, e.date, true);
      ch.setUint32(16, e.crc, true); ch.setUint32(20, e.csize, true); ch.setUint32(24, e.usize, true);
      ch.setUint16(28, e.name.length, true); ch.setUint32(42, e.offset, true);
      cd.push(new Uint8Array(ch.buffer), e.name); cdSize += 46 + e.name.length;
    });
    var eo = new DataView(new ArrayBuffer(22));
    eo.setUint32(0, 0x06054b50, true); eo.setUint16(8, central.length, true); eo.setUint16(10, central.length, true);
    eo.setUint32(12, cdSize, true); eo.setUint32(16, offset, true);
    var all = parts.concat(cd, [new Uint8Array(eo.buffer)]), total = all.reduce(function (n, p) { return n + p.length; }, 0);
    var out = new Uint8Array(total), at = 0; all.forEach(function (p) { out.set(p, at); at += p.length; });
    return out;
  }

  function clean(name) { return name.replace(/\/$/, '').replace(/\?$/, ''); }
  async function bytesOf(loc) { var v = await sh.readValue(loc); return v.bytes !== undefined ? v.bytes : new TextEncoder().encode(v.text || ''); }

  // Collect {name, bytes} entries for one argument. A data object is one entry under its own name; a container (-r
  // only) contributes its objects under "<name>/<path>". References and queues are skipped with a note.
  async function collect(arg, entries) {
    var loc = sh.resolve(arg), at = await sh.locate(loc);
    if (at.outside) throw new sh.Fail(0, 'leads outside the mounted namespaces');
    var base = clean(arg.split('/').filter(Boolean).pop() || arg);
    if (!at.dir) { entries.push({ name: base, bytes: await bytesOf(at.loc) }); return; }
    if (!recurse) { c.stderr('zip: ' + arg + ': is a container (use -r)'); return; }
    await walk(at.loc, base + '/', entries);
  }
  async function walk(loc, prefix, entries) {
    var dir = await sh.readDir(loc, false);
    if (!dir.kids.length) { entries.push({ name: prefix, bytes: new Uint8Array(0) }); return; }   // keep an empty container as a directory entry
    for (var i = 0; i < dir.kids.length; i++) {
      var k = dir.kids[i], nm = clean(k.name), child = { ns: loc.ns, segs: loc.segs.concat(nm) };
      if (k.kind === 'd') await walk(child, prefix + nm + '/', entries);
      else if (k.kind === 'o') { try { entries.push({ name: prefix + nm, bytes: await bytesOf(child) }); } catch (e) { c.stderr('zip: ' + prefix + nm + ': ' + e.message); } }
      else c.stderr('zip: ' + prefix + nm + ': skipped (' + (k.kind === 'r' ? 'reference' : 'queue') + ')');
    }
  }

  (async function () {
    try {
      var entries = [];
      for (var i = 0; i < paths.length; i++) await collect(paths[i], entries);
      if (!entries.length) { c.stderr('zip: nothing to archive'); return c.exit(1); }
      c.stdout('\x1b[2mpacking ' + entries.length + ' entr' + (entries.length === 1 ? 'y' : 'ies') + (store ? ', stored' : '') + ' …\x1b[0m');
      var zip = await makeZip(entries);
      await sh.cdmi(sh.leafURL(sh.resolve(dest)), sh.T_OBJECT, 'PUT',
        JSON.stringify({ mimetype: 'application/zip', metadata: {}, valuetransferencoding: 'base64', value: b64(zip) }));
      entries.forEach(function (e) { c.stdout('  ' + (e.name.length > 60 ? '…' + e.name.slice(-59) : e.name)); });
      c.stdout('\x1b[32m' + dest + ': ' + entries.length + ' entr' + (entries.length === 1 ? 'y' : 'ies') + ', ' + zip.length + ' bytes\x1b[0m');
      c.exit(0);
    } catch (e) { c.stderr('zip: ' + (e && e.message || e)); c.exit(1); }
  })();
})();
