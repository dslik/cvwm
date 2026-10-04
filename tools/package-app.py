#!/usr/bin/env python3
"""Write a cvwm application (or the shared resource fork) to a .cdmi file: the canonical CDMI serialization a server's
deserialize accepts. This is a convenience for ad-hoc, offline use -- for example to produce a single .cdmi to hand to
the deserialize dialog in the desktop, or to inspect the exact shape that will be deployed.

The installers (install.py, tools/update-cvwm.py) no longer read files written here: they serialize each application
from apps/ on the fly and deserialize it in one request, so apps/ is the only stored copy and nothing can drift. The
serialization logic itself lives in tools/cdmi_serialize.py and is shared by all three.

Naming follows the deployed layout: an application's own files keep their names (index.js, index.png), and everything
under an application's `rsrc/` fork is a resource addressed by a slug -- its file extension dropped, its mimetype taken
from that extension. A file directly under a fork is a collection object; a subdirectory is a per-object category.

Usage:
    package-app.py <folder> --name <deployed-name> [--fork] -o <out.cdmi>
    package-app.py --all <package-root> -o <dist-dir>      # every app + the shared fork

--fork marks a folder that is itself a resource fork (the shared apps/rsrc), so the slug rule applies from its root.
"""
import argparse, json, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdmi_serialize import package


# The deployed layout, shared with install.py / update-cvwm.py: the CDMI applications are grouped under apps/cdmi/,
# the general utilities under apps/utils/; the rest sit directly under apps/.
CDMI_APPS = ["capabilities", "domains", "namespaces", "postcdmi", "queues", "relationships", "servers", "notifications", "query"]
UTILS_APPS = ["console", "xterm", "capture", "framer"]
APPS = ["earthworm", "textile", "xclock", "mcpinspector", "mdviewer", "pdfviewer"] + UTILS_APPS + CDMI_APPS


def app_folder(root, a):
    group = "cdmi" if a in CDMI_APPS else "utils" if a in UTILS_APPS else None
    return os.path.join(root, "apps", group, a) if group else os.path.join(root, "apps", a)


def package_all(root, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    made = []
    for a in APPS:
        folder = app_folder(root, a)
        if not os.path.isdir(folder):
            continue
        doc = package(folder, a, False)
        p = os.path.join(out_dir, a + ".cdmi")
        open(p, "w", encoding="utf-8").write(json.dumps(doc))
        made.append((a, p))
    sysfork = os.path.join(root, "rsrc")           # the shared system fork lives in the desktop container
    if os.path.isdir(sysfork):
        doc = package(sysfork, "rsrc", True)
        p = os.path.join(out_dir, "rsrc.cdmi")
        open(p, "w", encoding="utf-8").write(json.dumps(doc))
        made.append(("rsrc (system fork)", p))
    return made


def main(argv):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("folder", nargs="?", help="the application (or fork) directory to package")
    ap.add_argument("--name", help="the deployed name (e.g. console); defaults to the folder's basename")
    ap.add_argument("--fork", action="store_true", help="the folder is itself a resource fork (the slug rule applies from its root)")
    ap.add_argument("--all", metavar="ROOT", help="package every app and the shared fork from a package root")
    ap.add_argument("-o", "--out", required=True, help="output .cdmi file, or (with --all) an output directory")
    args = ap.parse_args(argv)
    if args.all:
        made = package_all(args.all, args.out)
        for name, p in made:
            print("%-16s -> %s (%d bytes)" % (name, p, os.path.getsize(p)))
        print("Packaged %d serializations." % len(made))
        return 0
    if not args.folder:
        ap.error("give a folder to package, or --all <root>")
    name = args.name or os.path.basename(args.folder.rstrip("/"))
    doc = package(args.folder, name, args.fork)
    open(args.out, "w", encoding="utf-8").write(json.dumps(doc))
    print("%s -> %s (%d bytes)" % (name, args.out, os.path.getsize(args.out)))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
