/*! pwd [-u] - the current container; -u prints its URI. A cvwm command. */
(function () {
  var c = window.CDMI_CONTEXT, sh = c.shell;
  c.stdout(c.argv[1] === '-u' ? c.cwd : sh.show(sh.cwd(), true)); c.exit(0);
})();
