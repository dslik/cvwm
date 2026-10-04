/*! head [-n N] object - the first N lines of a value (default 10). A cvwm command. */
(function () {
  var c = window.CDMI_CONTEXT, sh = c.shell, o = sh.opts(c.argv.slice(1), { n: 'value' }), n = parseInt(o.n, 10) || 10;
  if (!o._.length) { c.stderr('usage: head [-n N] object'); return c.exit(2); }
  (async function () {
    try { var text = sh.asText(await sh.readValue(sh.resolve(o._[0]))); if (text === null) throw new sh.Fail(0, 'binary value; try hexdump'); c.stdout(text.split('\n').slice(0, n).join('\n')); c.exit(0); }
    catch (e) { c.stderr('head: ' + o._[0] + ': ' + e.message); c.exit(1); }
  })();
})();
