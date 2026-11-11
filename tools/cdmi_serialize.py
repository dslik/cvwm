"""Serialize a cvwm application (or resource fork) directory to the CDMI canonical format.

This is the one place that turns a source directory into the serialization a CDMI server's deserialize accepts
(revision 365 Serialization): each object's value carried inline, and a container's children nested within it as
complete representations. It is the single source of truth for that shape, shared by:

  * package-app.py     -- the CLI, for writing a .cdmi file on demand (e.g. to hand to the deserialize dialog);
  * install.py         -- fresh install, which serializes each app from source and deserializes it in one PUT;
  * tools/update-cvwm.py -- update, likewise.

Because the installers serialize from apps/ at deploy time, there is no stored, checked-in copy to drift from the
source -- apps/ is the only copy of an application's files.

Naming follows the deployed layout: every object keeps its file name, extension and all (index.js, filetypes.json,
en.json, mdviewer.css), with its mimetype taken from that extension. A file directly under a fork is a collection
object; a subdirectory is a per-object category. (cvwm's resource manager also exposes each resource under its short
id -- the name without the extension -- so an app can address "en" or "en.json".)

Uses nothing outside the Python standard library.
"""
import base64, json, mimetypes, os

CONTAINER = "application/cdmi-container"
OBJECT = "application/cdmi-object"


def mime_of(name):
    return "text/javascript" if name.endswith(".js") else (mimetypes.guess_type(name)[0] or "application/octet-stream")


def data_object(path, obj_name):
    data = open(path, "rb").read()
    mime = mime_of(os.path.basename(path))
    node = {"objectType": OBJECT, "objectName": obj_name, "completionStatus": "Complete", "metadata": {}, "mimetype": mime}
    try:
        if not (mime.startswith("text/") or mime.endswith("json")):
            raise UnicodeDecodeError("utf-8", b"", 0, 1, "binary")
        node["valuetransferencoding"] = "utf-8"
        node["value"] = data.decode("utf-8")
    except UnicodeDecodeError:
        node["valuetransferencoding"] = "base64"
        node["value"] = base64.b64encode(data).decode("ascii")
    return node


def manifest_object(built_against):
    """The rsrc/manifest.json the desktop gates on: it records the cvwm version this app was built against."""
    value = json.dumps({"builtAgainst": built_against}, indent=2)
    return {"objectType": OBJECT, "objectName": "manifest.json", "completionStatus": "Complete", "metadata": {},
            "mimetype": "application/json", "valuetransferencoding": "utf-8", "value": value}


def _stamp_manifest(children, built_against):
    """Put manifest.json into an app's rsrc/ fork (creating the fork if the app has none), replacing any existing one."""
    rsrc = next((c for c in children if c.get("objectName") == "rsrc/"), None)
    if rsrc is None:
        rsrc = {"objectType": CONTAINER, "objectName": "rsrc/", "completionStatus": "Complete", "metadata": {},
                "children": [], "childrenrange": ""}
        children.append(rsrc)
    kids = [c for c in rsrc["children"] if c.get("objectName") != "manifest.json"]
    kids.append(manifest_object(built_against))
    rsrc["children"] = kids
    rsrc["childrenrange"] = "0-%d" % (len(kids) - 1)


def container(path, obj_name, in_fork, built_against=None):
    """A container object and everything it holds. Object names keep their file extensions, inside the fork and out."""
    children = []
    for name in sorted(os.listdir(path)):
        full = os.path.join(path, name)
        if os.path.isdir(full):
            child_fork = in_fork or name == "rsrc"          # descending into rsrc/ begins the fork
            children.append(container(full, name + "/", child_fork, built_against))
        elif os.path.isfile(full):
            children.append(data_object(full, name))
    # An application is a container holding index.js. Stamp the cvwm version it is built against into its rsrc/ fork so
    # the desktop can refuse to run it on an incompatible build (see docs/app-compatibility.md). Done here, at deploy
    # time, so apps/ carries no stamped copy to drift: every deploy stamps the version it deploys with.
    if built_against and not in_fork and any(c.get("objectName") == "index.js" for c in children):
        _stamp_manifest(children, built_against)
    node = {"objectType": CONTAINER, "objectName": obj_name, "completionStatus": "Complete", "metadata": {},
            "children": children, "childrenrange": ("0-%d" % (len(children) - 1)) if children else ""}
    return node


def package(folder, deployed_name, is_fork=False, built_against=None):
    """The canonical serialization document (a dict) for a directory deployed under `deployed_name`.

    built_against is the cvwm version to stamp into an app's rsrc/manifest.json (None leaves apps unstamped, which the
    desktop then refuses to run -- callers that deploy apps should always pass it)."""
    return container(folder, deployed_name.rstrip("/") + "/", is_fork, built_against)


def serialize(folder, deployed_name, is_fork=False, built_against=None):
    """The canonical serialization of a directory, as UTF-8 bytes ready to base64 into a deserializevalue."""
    return json.dumps(package(folder, deployed_name, is_fork, built_against)).encode("utf-8")
