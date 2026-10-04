#!/usr/bin/env python3
"""Install the cvwm applications into a CDMI 3 server.

    python3 install.py https://cloud.example.com/cdmi/3.0.0/ --token <bearer token>
    python3 install.py https://cloud.example.com/cdmi/3.0.0/ --basic user:password --apps xterm textile
    python3 install.py https://cloud.example.com/cdmi/3.0.0/ --desktop desktop

Each application directory under apps/ beside this script becomes a container of the same name under /apps/ at the
base URI, each command directory under bin/ one under /bin/, and each under dev/tests/ one under /dev/tests/; each file in them becomes a data object: text as
UTF-8, anything else as base64. --desktop NAME also stores cvwm.js and index.html in a container of that name, for a server
that serves its objects to browsers through an HTTP export. Only https: base URIs are accepted. Uses nothing outside the Python standard library.
"""
import argparse, base64, json, mimetypes, os, ssl, sys, time, urllib.error, urllib.parse, urllib.request

# Applications are grouped into sub-containers of apps/: the CDMI applications under apps/cdmi/, the general utilities
# under apps/utils/; the rest sit directly under apps/.
CDMI_APPS = ["capabilities", "domains", "namespaces", "postcdmi", "queues", "relationships", "servers", "notifications", "query"]
UTILS_APPS = ["console", "xterm", "capture", "framer"]
APPS = ["earthworm", "textile", "xclock", "mcpinspector", "mdviewer", "pdfviewer"] + UTILS_APPS + CDMI_APPS
BIN = ["ls", "pwd", "cat", "head", "hexdump", "stat", "caps", "tree", "df", "echo", "open", "which", "nc", "ssh"]
HERE = os.path.dirname(os.path.abspath(__file__))
# Test commands are optional and not part of a release package: whatever directories exist under dev/tests/ (none in a
# release) are offered to --tests, so the installer runs cleanly whether or not they are present.
_TESTS_DIR = os.path.join(HERE, "dev", "tests")
TESTS = sorted(d for d in os.listdir(_TESTS_DIR) if os.path.isdir(os.path.join(_TESTS_DIR, d))) if os.path.isdir(_TESTS_DIR) else []

# Applications are serialized from apps/ on the fly and deserialized in one request, so apps/ is the only stored copy
# (no checked-in .cdmi to drift from it). The serialization logic is shared with tools/package-app.py and update-cvwm.py.
sys.path.insert(0, os.path.join(HERE, "tools"))
from cdmi_serialize import serialize


def app_job(a):
    """The deployed path and local folder for an application: apps/cdmi/<a> for the CDMI apps, apps/utils/<a> for the
    utilities, apps/<a> otherwise."""
    group = "cdmi/" if a in CDMI_APPS else "utils/" if a in UTILS_APPS else ""
    return ("apps/" + group + a, os.path.join(HERE, "apps", group.rstrip("/"), a) if group else os.path.join(HERE, "apps", a), None)


def put(url, media_type, body, headers, context):
    req = urllib.request.Request(url, data=json.dumps(body).encode("utf-8"), method="PUT",
                                 headers=dict(headers, **{"Content-Type": media_type, "Accept": media_type}))
    try:
        with urllib.request.urlopen(req, context=context) as res:
            return res.status
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:300]
        raise SystemExit("PUT %s failed: %s %s\n%s" % (url, e.code, e.reason, detail))


def get_field(url, field, headers, context, accept="application/cdmi-container"):
    """GET one field of an object, returning its value or None (used to poll completionStatus). `accept` must name the
    kind the URL returns as -- a deserialize destination is a container, so it defaults to application/cdmi-container
    (asking for application/cdmi-object there is answered 406)."""
    try:
        req = urllib.request.Request(url + "?" + field, method="GET",
                                     headers=dict(headers, **{"Accept": accept}))
        with urllib.request.urlopen(req, context=context) as res:
            return json.loads(res.read().decode("utf-8")).get(field)
    except Exception:
        return None


def deserialize_package(base, deploy_path, blob, label, headers, context):
    """Install an application (or the shared fork) from its CDMI serialization: one PUT carrying the canonical format
    inline (deserializevalue), recreating the whole container and everything in it. The blob is serialized from source
    by the caller. Deserialization may complete asynchronously, so completionStatus is polled until it is no longer
    Processing."""
    dest = base + deploy_path.rstrip("/") + "/"
    body = {"deserializevalue": base64.b64encode(blob).decode("ascii")}
    status = put(dest, "application/cdmi-container", body, headers, context)
    for _ in range(120):                                   # up to ~60s; deserialization is usually immediate
        cs = get_field(dest, "completionStatus", headers, context)
        if cs is None or cs == "Complete":
            break
        if str(cs).startswith("Error"):
            raise SystemExit("deserialize %s failed: completionStatus %s" % (dest, cs))
        time.sleep(0.5)
    print("%s  (deserialized from %s, %d bytes)  (%s)" % (deploy_path, label, len(blob), status))


def copy_container_acl(base, src, dst, headers, context):
    """Give the destination container the same cdmi_acl as the source, so apps/cdmi/ matches apps/."""
    try:
        req = urllib.request.Request(base + src + "?metadata=cdmi_acl", method="GET",
                                     headers=dict(headers, **{"Accept": "application/cdmi-container"}))
        with urllib.request.urlopen(req, context=context) as res:
            acl = (json.loads(res.read().decode("utf-8")).get("metadata") or {}).get("cdmi_acl")
    except Exception as e:
        print("  (could not read %s ACL; %s left to inherit: %s)" % (src, dst, e))
        return
    if not acl:
        return
    req = urllib.request.Request(base + dst, data=json.dumps({"metadata": {"cdmi_acl": acl}}).encode("utf-8"),
                                 method="PATCH", headers=dict(headers, **{"Content-Type": "application/cdmi-container",
                                                                          "Accept": "application/cdmi-container"}))
    try:
        with urllib.request.urlopen(req, context=context) as res:
            print("  %s ACL set to match %s  (%s)" % (dst, src, res.status))
    except urllib.error.HTTPError as e:
        print("  (setting %s ACL from %s returned %s)" % (dst, src, e.code))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("base", help="base URI of the namespace, ending in /")
    ap.add_argument("--token", help="bearer token")
    ap.add_argument("--basic", metavar="USER:PASSWORD", help="basic credentials")
    ap.add_argument("--apps", nargs="*", default=APPS, choices=APPS, help="which applications (default: all; --apps alone: none)")
    ap.add_argument("--bin", nargs="*", default=BIN, choices=BIN, help="which commands (default: all; --bin alone: none)")
    ap.add_argument("--tests", nargs="*", default=TESTS, choices=TESTS, help="which test commands into /dev/tests (default: all; --tests alone: none)")
    ap.add_argument("--desktop", metavar="NAME", help="also store cvwm.js and index.html in this container")
    ap.add_argument("--no-verify", action="store_true", help="accept a self-signed certificate (the connection is still TLS)")
    args = ap.parse_args()

    base = args.base if args.base.endswith("/") else args.base + "/"
    if urllib.parse.urlsplit(base).scheme != "https":
        raise SystemExit("Only https: base URIs are accepted: the desktop and its tools connect over TLS only.")
    headers = {}
    if args.token:
        headers["Authorization"] = "Bearer " + args.token
    elif args.basic:
        headers["Authorization"] = "Basic " + base64.b64encode(args.basic.encode("utf-8")).decode("ascii")
    context = ssl.create_default_context()
    if args.no_verify:
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE

    jobs = []
    if args.apps:
        put(base + "apps/", "application/cdmi-container", {"metadata": {}}, headers, context)
        for grp in [g for g, members in (("cdmi/", CDMI_APPS), ("utils/", UTILS_APPS)) if any(a in members for a in args.apps)]:
            put(base + "apps/" + grp, "application/cdmi-container", {"metadata": {}}, headers, context)
            copy_container_acl(base, "apps/", "apps/" + grp, headers, context)   # a group container carries apps/'s ACL
        jobs += [app_job(a) for a in args.apps]
    if args.bin: put(base + "bin/", "application/cdmi-container", {"metadata": {}}, headers, context); jobs += [("bin/" + b, os.path.join(HERE, "bin", b), None) for b in args.bin]
    if args.tests:
        put(base + "dev/", "application/cdmi-container", {"metadata": {}}, headers, context); put(base + "dev/tests/", "application/cdmi-container", {"metadata": {}}, headers, context)
        jobs += [("dev/tests/" + t, os.path.join(HERE, "dev", "tests", t), None) for t in args.tests]
    if args.desktop:
        # index.js/index.png make the desktop container show a "this provides the desktop" stub if it is ever opened
        # as an application (a container with an index.js), rather than trying to run the window manager in a window.
        jobs.append((args.desktop.strip("/"), HERE, ["cvwm.js", "index.html", "index.js", "index.png"]))
    for app, folder, only in jobs:
        # An application is serialized from its apps/ source and installed with one deserialize, which recreates the
        # container and everything in it, its resource fork included. apps/ is the only stored copy of its files.
        # The desktop, bin and tests jobs are not applications, so they write files (and the system fork) directly.
        if app.startswith("apps/"):
            name = app.split("/")[-1]
            blob = serialize(folder, name, is_fork=False)
            deserialize_package(base, app, blob, name + ".cdmi", headers, context)
            continue
        is_desktop = bool(args.desktop) and app == args.desktop.strip("/")
        sys_fork_url = base + app + "/rsrc/" if is_desktop else None   # the system fork lives in the desktop container
        status = put(base + app + "/", "application/cdmi-container", {"metadata": {}}, headers, context)
        print("%s/  (%s)" % (app, status))
        for name in (only or sorted(os.listdir(folder))):
            path = os.path.join(folder, name)
            if not os.path.isfile(path):
                continue
            data = open(path, "rb").read()
            mime = "text/javascript" if name.endswith(".js") else (mimetypes.guess_type(name)[0] or "application/octet-stream")
            body = {"mimetype": mime, "metadata": {}}
            try:
                if not (mime.startswith("text/") or mime.endswith("json")):
                    raise UnicodeDecodeError("utf-8", b"", 0, 1, "binary")
                text = data.decode("utf-8")
                # Point the desktop at the system fork in its own container: cvwm.js reads data-rsrc off its script tag.
                if is_desktop and name == "index.html" and 'data-rsrc' not in text:
                    text = text.replace('<script src="cvwm.js">', '<script src="cvwm.js" data-rsrc="%s">' % sys_fork_url, 1)
                body.update(valuetransferencoding="utf-8", value=text)
            except UnicodeDecodeError:
                body.update(valuetransferencoding="base64", value=base64.b64encode(data).decode("ascii"))
            status = put(base + app + "/" + urllib.parse.quote(name), "application/cdmi-object", body, headers, context)
            print("  %-12s %7d bytes  %s  (%s)" % (name, len(data), mime, status))
        # The shared system fork is serialized from rsrc/ and installed into the desktop container with one deserialize.
        if is_desktop:
            sys_src = os.path.join(HERE, "rsrc")
            if os.path.isdir(sys_src):
                blob = serialize(sys_src, "rsrc", is_fork=True)
                deserialize_package(base, app + "/rsrc", blob, "rsrc.cdmi", headers, context)
    print("Done. Reload the desktop, or choose Rescan namespaces from its root menu.")


if __name__ == "__main__":
    main()
