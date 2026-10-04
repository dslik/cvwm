/*! cat object... - print the value of data objects; a binary value is shown as a hex dump. A cvwm command. */
(function () {
  var c = window.CDMI_CONTEXT, sh = c.shell, args = c.argv.slice(1);
  if (!args.length || args[0] === '--help') { c.stderr('usage: cat object...'); return c.exit(args.length ? 0 : 2); }
  (async function () {
    var code = 0;
    for (var i = 0; i < args.length; i++) {
      try {
        var v = await sh.readValue(sh.resolve(args[i])), text = sh.asText(v);
        if (text === null) { c.stdout('\x1b[2m' + args[i] + ': ' + v.bytes.length + ' bytes of ' + (v.rep.mimetype || 'binary') + ', showing a hex dump\x1b[0m'); sh.hexdump(v.bytes, 256).forEach(c.stdout); }
        else c.stdout(text);
      } catch (e) { c.stderr('cat: ' + args[i] + ': ' + e.message); code = 1; }
    }
    c.exit(code);
  })();
})();
