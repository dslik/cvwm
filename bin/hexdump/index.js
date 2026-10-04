/*! hexdump [-n BYTES] object - a hex dump of a value (default 256 bytes). A cvwm command. */
(function () {
  var c = window.CDMI_CONTEXT, sh = c.shell, o = sh.opts(c.argv.slice(1), { n: 'value' });
  if (!o._.length) { c.stderr('usage: hexdump [-n BYTES] object'); return c.exit(2); }
  (async function () {
    try { var v = await sh.readValue(sh.resolve(o._[0])); sh.hexdump(v.bytes || new TextEncoder().encode(v.text), parseInt(o.n, 10) || 256).forEach(c.stdout); c.exit(0); }
    catch (e) { c.stderr('hexdump: ' + o._[0] + ': ' + e.message); c.exit(1); }
  })();
})();
