/*! echo text... - print its arguments. A cvwm command, and the smallest one. */
(function () { var c = window.CDMI_CONTEXT; c.stdout(c.argv.slice(1).join(' ')); c.exit(0); })();
