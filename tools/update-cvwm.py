#!/usr/bin/env python3
"""Update a running cvwm instance to the files of this release package.

    python3 tools/update-cvwm.py https://cloud.example.com/cdmi/3.0.0/ --desktop desktop
    python3 tools/update-cvwm.py https://cloud.example.com/cdmi/3.0.0/ --basic user:password --prune
    python3 tools/update-cvwm.py https://cloud.example.com/cdmi/3.0.0/ --token <bearer> --apps xterm textile

It compares the files already deployed at the base URI with the ones in this package (the parent directory of this
script's tools/ folder) and writes only what has changed: a data object whose value already matches is left alone, a
new object is created, and -- with --prune -- an object that the package no longer contains is deleted. Containers
themselves are never deleted. Before writing anything it reads the deployed desktop's version and refuses to move to
an older package unless --force is given, so a stale checkout cannot roll a live instance back by accident.

The layout matches install.py: the applications under apps/, the commands under bin/, the tests under dev/tests/,
and, with --desktop NAME, cvwm.js and index.html in the container of that name. Only https: base URIs are accepted,
and nothing outside the Python standard library is used.

This updates the files cvwm is served from; it does not touch the store's data, ACLs, exports, or the seedmi
configuration. After it finishes, reload the desktop in the browser (a hard reload, so the new cvwm.js is fetched).
"""
import argparse, base64, json, mimetypes, os, re, ssl, sys, time, urllib.error, urllib.parse, urllib.request

# The same sets install.py uses; kept here so an update covers exactly what an install laid down.
# Keep APPS/BIN/TESTS in sync with install.py, so an update deploys exactly what an install would.
# Applications are grouped into sub-containers of apps/: the CDMI applications under apps/cdmi/, the general utilities
# under apps/utils/; the rest sit directly under apps/.
CDMI_APPS = ["capabilities", "domains", "namespaces", "postcdmi", "queues", "relationships", "servers", "notifications", "query"]
UTILS_APPS = ["console", "xterm", "capture", "framer"]
APPS = ["earthworm", "textile", "xclock", "mcpinspector", "mdviewer", "pdfviewer"] + UTILS_APPS + CDMI_APPS
BIN = ["ls", "pwd", "cat", "head", "hexdump", "stat", "caps", "tree", "df", "echo", "open", "which", "nc", "ssh"]
TESTS = ["vtest", "cryptotest"]
SCRIPT_VERSION = "1.1.0"   # update-cvwm.py (semver)
HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.dirname(HERE)                                  # the package root: tools/ sits inside it

# Applications are serialized from apps/ on the fly and deserialized in one request, so apps/ is the only stored copy
# (no checked-in .cdmi to drift from it). The serialization logic is shared with package-app.py and install.py.
sys.path.insert(0, HERE)
from cdmi_serialize import serialize

CONTAINER = "application/cdmi-container"
OBJECT = "application/cdmi-object"


class Http:
    """The small CDMI client this needs: GET a representation, PUT one, DELETE one, over TLS, with the standard lib."""
    def __init__(self, headers, context):
        self.headers = headers
        self.context = context

    def _do(self, method, url, media_type, body):
        data = json.dumps(body).encode("utf-8") if body is not None else None
        h = dict(self.headers)
        if media_type:
            h["Accept"] = media_type
            if data is not None:
                h["Content-Type"] = media_type
        req = urllib.request.Request(url, data=data, method=method, headers=h)
        try:
            with urllib.request.urlopen(req, context=self.context) as res:
                return res.status, res.read()
        except urllib.error.HTTPError as e:
            return e.code, e.read()
        except urllib.error.URLError as e:
            reason = getattr(e, "reason", e)
            if isinstance(reason, ssl.SSLCertVerificationError) or "CERTIFICATE_VERIFY_FAILED" in str(reason):
                raise SystemExit(
                    "TLS certificate verification failed for %s\n"
                    "  %s\n\n"
                    "If this instance uses the self-signed certificate that setup-cvwm.py generated, re-run with "
                    "--no-verify (the connection is still encrypted). To verify it instead, trust that certificate "
                    "in the system's CA store." % (urllib.parse.urlsplit(url).netloc, reason))
            raise SystemExit("Could not reach %s: %s" % (urllib.parse.urlsplit(url).netloc, reason))

    def get_json(self, url, media_type):
        status, raw = self._do("GET", url, media_type, None)
        if status == 404:
            return None
        if status >= 400:
            raise SystemExit("GET %s failed: HTTP %s\n%s" % (url, status, raw.decode("utf-8", "replace")[:300]))
        try:
            return json.loads(raw.decode("utf-8", "replace"))
        except ValueError:
            return None

    def put(self, url, media_type, body):
        status, raw = self._do("PUT", url, media_type, body)
        if status >= 400:
            raise SystemExit("PUT %s failed: HTTP %s\n%s" % (url, status, raw.decode("utf-8", "replace")[:300]))
        return status

    def patch(self, url, media_type, body):
        status, raw = self._do("PATCH", url, media_type, body)
        if status >= 400:
            raise SystemExit("PATCH %s failed: HTTP %s\n%s" % (url, status, raw.decode("utf-8", "replace")[:300]))
        return status

    def delete(self, url):
        status, raw = self._do("DELETE", url, OBJECT, None)
        if status >= 400 and status != 404:
            raise SystemExit("DELETE %s failed: HTTP %s\n%s" % (url, status, raw.decode("utf-8", "replace")[:300]))
        return status


def read_file(path):
    """A file as (mimetype, transfer-encoding, value) for a CDMI PUT, exactly as install.py encodes it."""
    data = open(path, "rb").read()
    name = os.path.basename(path)
    mime = "text/javascript" if name.endswith(".js") else (mimetypes.guess_type(name)[0] or "application/octet-stream")
    try:
        if not (mime.startswith("text/") or mime.endswith("json")):
            raise UnicodeDecodeError("utf-8", b"", 0, 1, "binary")
        return mime, "utf-8", data.decode("utf-8"), len(data)
    except UnicodeDecodeError:
        return mime, "base64", base64.b64encode(data).decode("ascii"), len(data)


def deployed_value(http, url):
    """The value already stored at an object URL, decoded to text where it is text, or None if there is none there."""
    rep = http.get_json(url + "?value&valuetransferencoding&mimetype", OBJECT)
    if rep is None or "value" not in rep:
        return None
    if rep.get("valuetransferencoding") == "base64":
        return ("base64", rep["value"])
    return ("utf-8", rep["value"])


def cvwm_version(text):
    m = re.search(r"cvwm version:\s*([0-9]+\.[0-9]+\.[0-9]+)", text or "")
    return m.group(1) if m else None


def deserialize_package(http, base, deploy_path, blob, label, counts):
    """Update an application (or the shared fork) from its CDMI serialization: one PUT carrying the canonical format
    inline (deserializevalue) recreates the container and everything in it, so it replaces the deployed copy wholesale
    (no separate prune). The blob is serialized from source by the caller. Deserialization may complete asynchronously,
    so completionStatus is polled."""
    dest = base + deploy_path.rstrip("/") + "/"
    http.put(dest, CONTAINER, {"deserializevalue": base64.b64encode(blob).decode("ascii")})
    for _ in range(120):
        cs = (http.get_json(dest + "?completionStatus", CONTAINER) or {}).get("completionStatus")   # dest is a container
        if cs is None or cs == "Complete":
            break
        if str(cs).startswith("Error"):
            raise SystemExit("deserialize %s failed: completionStatus %s" % (dest, cs))
        time.sleep(0.5)
    counts["update"] += 1
    print("  deserialized from %s  (%d bytes)" % (label, len(blob)))


def semver(v):
    try:
        return tuple(int(x) for x in v.split("."))
    except (AttributeError, ValueError):
        return None


def check_version(http, base, desktop, force):
    """Compare the deployed desktop's cvwm version with this package's, and stop on a downgrade unless forced."""
    pkg_ver = cvwm_version(open(os.path.join(PKG, "cvwm.js"), encoding="utf-8").read())
    pkg_rel = None
    rel_path = os.path.join(PKG, "VERSION")
    if os.path.isfile(rel_path):
        pkg_rel = open(rel_path, encoding="utf-8").read().strip()
    print("This package: cvwm %s (release %s)" % (pkg_ver or "?", pkg_rel or "?"))
    if not desktop:
        print("No --desktop given, so the deployed version is not read; updating apps/bin/tests only.")
        return
    got = deployed_value(http, base + desktop.strip("/") + "/cvwm.js")
    if got is None:
        print("No cvwm.js is deployed at %s%s/ yet; this will install it." % (base, desktop.strip("/")))
        return
    dep_ver = cvwm_version(got[1] if got[0] == "utf-8" else base64.b64decode(got[1]).decode("utf-8", "replace"))
    print("Deployed:     cvwm %s" % (dep_ver or "?"))
    a, b = semver(dep_ver), semver(pkg_ver)
    if a and b and b < a and not force:
        raise SystemExit("This package (cvwm %s) is older than what is deployed (cvwm %s). "
                         "Use --force to install it anyway." % (pkg_ver, dep_ver))
    if a and b and b == a and not force:
        print("The deployed desktop is already at cvwm %s; only changed files will be written." % dep_ver)


def copy_container_acl(http, base, src_rel, dst_rel):
    """Give the destination container the same cdmi_acl as the source, so apps/cdmi/ matches apps/."""
    rep = http.get_json(base + src_rel + "?metadata=cdmi_acl", CONTAINER) or {}
    acl = (rep.get("metadata") or {}).get("cdmi_acl")
    if not acl:
        print("  %s has no explicit ACL; %s left to inherit" % (src_rel, dst_rel))
        return
    http.patch(base + dst_rel, CONTAINER, {"metadata": {"cdmi_acl": acl}})
    print("  %s ACL set to match %s" % (dst_rel, src_rel))


def ensure_container(http, url, created):
    """Make sure a container exists, without disturbing one that already does. A PUT of a container replaces it, and a
    PUT carrying no `exports` clears the container's exports -- which would deactivate the HTTP export that serves the
    desktop. So an existing container is left untouched; only a missing one is created."""
    if url in created:
        return
    rep = http.get_json(url + "?objectType", CONTAINER)
    if rep is None:                                          # 404: not there yet, so create it
        http.put(url, CONTAINER, {"metadata": {}})
    created.add(url)


def update_folder(http, base, rel, folder, only, prune, created, counts, rsrc_url=None):
    """Bring one deployed container in line with a local folder: write changed/new files, optionally prune the rest.
    `rsrc_url`, for the desktop container, is written onto index.html's script tag as data-rsrc so the desktop finds
    the system fork in its own container."""
    container = base + rel + "/"
    ensure_container(http, container, created)
    local = {}
    for name in (only or sorted(os.listdir(folder))):
        path = os.path.join(folder, name)
        if os.path.isfile(path):
            local[name] = path
    for name, path in sorted(local.items()):
        mime, enc, value, size = read_file(path)
        if rsrc_url and name == "index.html" and enc == "utf-8" and "data-rsrc" not in value:
            value = value.replace('<script src="cvwm.js">', '<script src="cvwm.js" data-rsrc="%s">' % rsrc_url, 1)
            size = len(value.encode("utf-8"))
        url = container + urllib.parse.quote(name)
        cur = deployed_value(http, url)
        if cur is not None and cur[0] == enc and cur[1] == value:
            counts["same"] += 1
            print("  %-14s unchanged" % name)
            continue
        verb = "update" if cur is not None else "create"
        http.put(url, OBJECT, {"mimetype": mime, "valuetransferencoding": enc, "metadata": {}, "value": value})
        counts[verb] += 1
        print("  %-14s %s  (%d bytes, %s)" % (name, verb + "d", size, mime))
    if prune:
        listing = http.get_json(container + "?children", CONTAINER) or {}
        for child in listing.get("children", []):
            if child.endswith("/"):
                continue                                    # a sub-container, left in place
            name = urllib.parse.unquote(child)
            if name not in local and not name.startswith("cdmi_"):
                http.delete(container + urllib.parse.quote(name))
                counts["prune"] += 1
                print("  %-14s pruned" % name)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("base", help="base URI of the running instance, ending in /")
    ap.add_argument("--token", help="bearer token")
    ap.add_argument("--basic", metavar="USER:PASSWORD", help="basic credentials")
    ap.add_argument("--apps", nargs="*", default=APPS, choices=APPS, help="which applications (default: all; --apps alone: none)")
    ap.add_argument("--bin", nargs="*", default=BIN, choices=BIN, help="which commands (default: all; --bin alone: none)")
    ap.add_argument("--tests", nargs="*", default=TESTS, choices=TESTS, help="which tests under /dev/tests (default: all; --tests alone: none)")
    ap.add_argument("--desktop", metavar="NAME", help="also update cvwm.js and index.html in this container")
    ap.add_argument("--prune", action="store_true", help="delete deployed files this package no longer contains (containers are never deleted)")
    ap.add_argument("--force", action="store_true", help="update even when the deployed version is the same or newer")
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
    http = Http(headers, context)

    check_version(http, base, args.desktop, args.force)

    created, counts = set(), {"create": 0, "update": 0, "same": 0, "prune": 0}
    jobs = []
    groups = [(g, members) for g, members in (("cdmi/", CDMI_APPS), ("utils/", UTILS_APPS)) if any(a in members for a in args.apps)]
    if groups:
        ensure_container(http, base + "apps/", created)
        for grp, _ in groups:
            ensure_container(http, base + "apps/" + grp, created)
            copy_container_acl(http, base, "apps/", "apps/" + grp)   # a group container carries the same ACL as apps/
    for a in args.apps:
        grp = "cdmi/" if a in CDMI_APPS else "utils/" if a in UTILS_APPS else ""
        folder = os.path.join(PKG, "apps", grp.rstrip("/"), a) if grp else os.path.join(PKG, "apps", a)
        jobs.append(("apps/" + grp + a, folder, None))
    for b in args.bin:
        jobs.append(("bin/" + b, os.path.join(PKG, "bin", b), None))
    if args.tests:
        ensure_container(http, base + "dev/", created)
        for t in args.tests:
            jobs.append(("dev/tests/" + t, os.path.join(PKG, "dev", "tests", t), None))
    if args.desktop:
        # index.js/index.png: the "this provides the desktop" stub and its icon, so the desktop container is not run as an app.
        jobs.append((args.desktop.strip("/"), PKG, ["cvwm.js", "index.html", "index.js", "index.png"]))

    for rel, folder, only in jobs:
        # An application is serialized from its apps/ source and updated with one deserialize, which recreates the whole
        # container (its resource fork included), replacing the deployed copy wholesale. apps/ is the only stored copy.
        # The desktop, bin and tests jobs are not applications, so they write files (and the system fork) directly.
        if rel.startswith("apps/"):
            if not os.path.isdir(folder):
                print("skipping %s: not in this package" % rel)
                continue
            name = rel.split("/")[-1]
            print("%s/  (serialized)" % rel)
            deserialize_package(http, base, rel, serialize(folder, name, is_fork=False), name + ".cdmi", counts)
            continue
        if not os.path.isdir(folder):
            print("skipping %s: not in this package" % rel)
            continue
        print("%s/" % rel)
        is_desktop = bool(args.desktop) and rel == args.desktop.strip("/")
        rsrc_url = base + rel + "/rsrc/" if is_desktop else None   # the system fork lives in the desktop container
        update_folder(http, base, rel, folder, only, args.prune, created, counts, rsrc_url)
        # The shared system fork is serialized from rsrc/ and updated into the desktop container with one deserialize.
        if is_desktop:
            sys_src = os.path.join(PKG, "rsrc")
            if os.path.isdir(sys_src):
                print("%s/rsrc/  (serialized)" % rel)
                deserialize_package(http, base, rel + "/rsrc", serialize(sys_src, "rsrc", is_fork=True), "rsrc.cdmi", counts)

    print("\nDone: %d created, %d updated, %d unchanged%s." % (
        counts["create"], counts["update"], counts["same"],
        (", %d pruned" % counts["prune"]) if args.prune else ""))
    print("Reload the desktop in the browser (a hard reload) so the new cvwm.js is fetched.")


if __name__ == "__main__":
    main()
