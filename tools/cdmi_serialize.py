"""Serialize a cvwm application (or resource fork) directory to the CDMI canonical format.

This is the one place that turns a source directory into the serialization a CDMI server's deserialize accepts
(revision 365 Serialization): each object's value carried inline, and a container's children nested within it as
complete representations. It is the single source of truth for that shape, shared by:

  * package-app.py     -- the CLI, for writing a .cdmi file on demand (e.g. to hand to the deserialize dialog);
  * install.py         -- fresh install, which serializes each app from source and deserializes it in one PUT;
  * tools/update-cvwm.py -- update, likewise.

Because the installers serialize from apps/ at deploy time, there is no stored, checked-in copy to drift from the
source -- apps/ is the only copy of an application's files.

Naming follows the deployed layout: an application's own files keep their names (index.js, index.png); everything
under an application's rsrc/ fork is a resource addressed by a slug -- its file extension dropped, its mimetype taken
from that extension. A file directly under a fork is a collection object; a subdirectory is a per-object category.

Uses nothing outside the Python standard library.
"""
import base64, json, mimetypes, os

CONTAINER = "application/cdmi-container"
OBJECT = "application/cdmi-object"


def mime_of(name):
    return "text/javascript" if name.endswith(".js") else (mimetypes.guess_type(name)[0] or "application/octet-stream")


def slug(name):
    """A resource's object name is its filename with the extension dropped."""
    root, ext = os.path.splitext(name)
    return root if ext else name


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


def container(path, obj_name, in_fork):
    """A container object and everything it holds. `in_fork` turns on the slug rule for a fork's contents."""
    children = []
    for name in sorted(os.listdir(path)):
        full = os.path.join(path, name)
        if os.path.isdir(full):
            child_fork = in_fork or name == "rsrc"          # descending into rsrc/ begins the fork
            child_name = (slug(name) if in_fork else name) + "/"
            children.append(container(full, child_name, child_fork))
        elif os.path.isfile(full):
            children.append(data_object(full, slug(name) if in_fork else name))
    node = {"objectType": CONTAINER, "objectName": obj_name, "completionStatus": "Complete", "metadata": {},
            "children": children, "childrenrange": ("0-%d" % (len(children) - 1)) if children else ""}
    return node


def package(folder, deployed_name, is_fork=False):
    """The canonical serialization document (a dict) for a directory deployed under `deployed_name`."""
    return container(folder, deployed_name.rstrip("/") + "/", is_fork)


def serialize(folder, deployed_name, is_fork=False):
    """The canonical serialization of a directory, as UTF-8 bytes ready to base64 into a deserializevalue."""
    return json.dumps(package(folder, deployed_name, is_fork)).encode("utf-8")
