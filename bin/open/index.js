/*! open [path] - open a container or object in a desktop window. A cvwm command. */
(function () {
  var c = window.CDMI_CONTEXT, sh = c.shell, arg = c.argv[1] || '.';
  if (!c.desktop) { c.stderr('open: there is no desktop to open it on'); return c.exit(126); }
  (async function () {
    try { var at = await sh.locate(sh.resolve(arg)); c.desktop.open(at.outside || (at.dir ? sh.dirURL(at.loc) : sh.leafURL(at.loc))); c.exit(0); }
    catch (e) { c.stderr('open: ' + arg + ': ' + e.message); c.exit(1); }
  })();
})();
