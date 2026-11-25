import argparse
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
import ctypes
from ctypes import wintypes
import hashlib
import http.client
import json
import logging
from logging.handlers import RotatingFileHandler
import msvcrt
import os
from pathlib import Path
import queue
import re
import secrets
import ssl
import stat
import threading
import time
from urllib.parse import urlsplit

from watchdog.events import FileSystemEventHandler
from watchdog.observers import Observer

INSTALLED_HOME = Path(__file__).resolve().parent
HOME = INSTALLED_HOME if (INSTALLED_HOME / "agent.json").is_file() else Path(os.environ["LOCALAPPDATA"]) / "PersonalFilePortal"
ROOTS = HOME / "roots"
REVOKED = HOME / "revoked"
LOGGER = logging.getLogger("fileportal")
REPARSE = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
ROOT_ID = re.compile(r"[a-f0-9]{32}")
get_final_path = ctypes.WinDLL("kernel32", use_last_error=True).GetFinalPathNameByHandleW
get_final_path.argtypes = (wintypes.HANDLE, wintypes.LPWSTR, wintypes.DWORD, wintypes.DWORD)
get_final_path.restype = wintypes.DWORD


class RegistrationRevoked(Exception):
    pass


def revocation_marker(root_id, revision):
    return REVOKED / (root_id + "." + (revision or "legacy"))


def remember_revocation(root_id, revision):
    if ROOT_ID.fullmatch(root_id) and (not revision or ROOT_ID.fullmatch(revision)):
        REVOKED.mkdir(exist_ok=True)
        revocation_marker(root_id, revision).touch(exist_ok=True)


def registrations():
    records = {}
    for file in ROOTS.glob("*.json"):
        if not ROOT_ID.fullmatch(file.stem):
            continue
        try:
            record = json.loads(file.read_text(encoding="utf-8"))
        except FileNotFoundError:
            continue
        if not revocation_marker(file.stem, record.get("revision", "")).exists():
            records[file.stem] = record
    return records


def reparse_or_link(info):
    return stat.S_ISLNK(info.st_mode) or bool(getattr(info, "st_file_attributes", 0) & REPARSE)


def final_path(handle):
    buffer = ctypes.create_unicode_buffer(32768)
    length = get_final_path(msvcrt.get_osfhandle(handle.fileno()), buffer, len(buffer), 0)
    if not 0 < length < len(buffer):
        raise OSError(ctypes.get_last_error(), "Cannot resolve file handle")
    value = buffer.value
    if value.startswith("\\\\?\\UNC\\"):
        return Path("\\\\" + value[8:])
    return Path(value[4:] if value.startswith("\\\\?\\") else value)


def local_path(root, relative):
    result = root
    if reparse_or_link(root.lstat()):
        raise PermissionError(root)
    for part in relative.split("/") if relative else ():
        if part in (".", "..", "") or any(char in part for char in "\\:\x00") or part.endswith((" ", ".")):
            raise PermissionError(relative)
        result = result / part
        if reparse_or_link(result.lstat()):
            raise PermissionError(result)
    return result


def scope_path(candidate):
    return os.path.normcase(str(candidate))


def registration_id(path):
    settings_path = HOME / "agent.json"
    settings = json.loads(settings_path.read_text(encoding="utf-8")) if settings_path.exists() else {}
    identity = scope_path(path)
    if settings.get("namespaceRoots"):
        identity = settings["device"] + ":" + identity
    return hashlib.sha256(identity.encode("utf-8")).hexdigest()[:32]


class Remote:
    def __init__(self):
        settings = json.loads((HOME / "agent.json").read_text(encoding="utf-8"))
        url = urlsplit(settings["url"])
        if url.scheme != "https":
            raise ValueError("The portal must use HTTPS")
        self.host = url.hostname
        self.port = url.port or 443
        self.base = url.path.rstrip("/") + "/agent/"
        self.headers = {"Authorization": "Bearer " + settings["token"],
                        "X-Portal-Device": settings["device"]}
        self.context = ssl.create_default_context()

    @contextmanager
    def connection(self, timeout=65):
        conn = http.client.HTTPSConnection(self.host, self.port, timeout=timeout, context=self.context)
        try:
            yield conn
        finally:
            conn.close()

    def json(self, route, payload=None, timeout=65):
        data = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
        with self.connection(timeout) as conn:
            conn.request("GET" if data is None else "POST", self.base + route, data,
                         dict(self.headers, **{"Content-Type": "application/json"}))
            response = conn.getresponse()
            if response.status != 200:
                raise OSError(f"{route}: HTTP {response.status}")
            return json.load(response)

    def send(self, job, status, handle=None, start=0, length=0, content_range=None):
        headers = dict(self.headers, **{"Content-Length": str(length), "X-File-Status": str(status)})
        if content_range:
            headers["X-File-Range"] = content_range
        with self.connection() as conn:
            conn.request("POST", self.base + "relay/" + job["id"], headers=headers)
            remaining = length
            if handle is not None:
                handle.seek(start)
            while remaining:
                chunk = handle.read(min(256 * 1024, remaining))
                if not chunk:
                    raise OSError("File changed while being read")
                conn.send(chunk)
                remaining -= len(chunk)
            response = conn.getresponse()
            response.read()
            if response.status not in (200, 410):
                raise OSError(f"relay: HTTP {response.status}")


def byte_range(value, size):
    if not value:
        return 200, 0, size, None
    first, last = value.removeprefix("bytes=").split("-", 1)
    if first:
        start = int(first)
        end = min(int(last), size - 1) if last else size - 1
    else:
        start = max(0, size - int(last))
        end = size - 1
    if start > end:
        return 416, 0, 0, f"bytes */{size}"
    return 206, start, end - start + 1, f"bytes {start}-{end}/{size}"


def deliver(remote, job):
    try:
        root = Path(registrations()[job["root"]]["path"])
        target = local_path(root, job["path"])
        if not target.is_file():
            raise FileNotFoundError(target)
        handle = target.open("rb")
    except (KeyError, FileNotFoundError, NotADirectoryError):
        remote.send(job, 404)
        return
    except OSError:
        remote.send(job, 503)
        return
    with handle:
        try:
            actual = final_path(handle)
            if scope_path(actual) != scope_path(target) or not actual.is_relative_to(root):
                remote.send(job, 404)
                return
            info = os.fstat(handle.fileno())
            if not stat.S_ISREG(info.st_mode):
                remote.send(job, 404)
                return
            status, start, length, content_range = byte_range(job["range"], info.st_size)
        except (OSError, ValueError):
            remote.send(job, 409)
            return
        remote.send(job, status, handle, start, length, content_range)


def poll(remote):
    def safely_deliver(job):
        try:
            deliver(remote, job)
        except Exception as error:
            LOGGER.info("Transfer ended: %s", type(error).__name__)

    with ThreadPoolExecutor(max_workers=12) as executor:
        while True:
            try:
                job = remote.json("poll")
                if job:
                    executor.submit(safely_deliver, job)
            except (OSError, ValueError, http.client.HTTPException) as error:
                LOGGER.warning("Server connection: %s", error)
                time.sleep(3)


class Changes(FileSystemEventHandler):
    def __init__(self, root_id, root, pending):
        self.root_id = root_id
        self.root = root
        self.pending = pending

    def on_any_event(self, event):
        if event.event_type not in {"created", "moved", "deleted", "modified"}:
            return
        for candidate in (event.src_path, event.dest_path):
            if candidate:
                path = Path(os.fsdecode(candidate))
                try:
                    relative = path.parent.relative_to(self.root)
                except ValueError:
                    if path == self.root:
                        self.pending.put((self.root_id, ""))
                else:
                    self.pending.put((self.root_id, "" if relative == Path(".") else relative.as_posix()))


def directory_entries(root, relative):
    folder = local_path(root, relative)
    results = []
    with os.scandir(folder) as children:
        for child in children:
            try:
                info = child.stat(follow_symlinks=False)
            except FileNotFoundError:
                continue
            if reparse_or_link(info) or not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)):
                continue
            is_folder = stat.S_ISDIR(info.st_mode)
            results.append({"name": child.name, "folder": is_folder,
                            "size": 0 if is_folder else info.st_size,
                            "mtime": info.st_mtime_ns // 1_000_000})
    return results


def sync_root(remote, root_id, record, paths, known, recursive):
    root = Path(record["path"])
    revision = record.get("revision", "")
    waiting = list(dict.fromkeys(paths))
    processed = set()
    batch = []
    batch_size = 0

    def flush():
        if batch:
            result = remote.json("index", {"id": root_id, "name": record["name"],
                                           "revision": revision, "dirs": batch})
            if result == {"revoked": True}:
                remember_revocation(root_id, revision)
                raise RegistrationRevoked()
            batch.clear()

    while waiting:
        relative = waiting.pop()
        if relative in processed:
            continue
        processed.add(relative)
        try:
            entries = directory_entries(root, relative)
        except (FileNotFoundError, NotADirectoryError):
            if not relative:
                raise
            continue
        except PermissionError:
            if not relative:
                raise
            LOGGER.warning("Skipped an unreadable subdirectory")
            continue
        prefix = relative + "/" if relative else ""
        children = {prefix + item["name"] for item in entries if item["folder"]}
        old = known.get(relative, set())
        for removed in old - children:
            for stale in tuple(known):
                if stale == removed or stale.startswith(removed + "/"):
                    known.pop(stale, None)
        waiting.extend(sorted(children if recursive else children - old, reverse=True))
        known[relative] = children
        snapshot = {"path": relative, "entries": entries}
        size = len(json.dumps(snapshot, ensure_ascii=False).encode("utf-8"))
        if batch and batch_size + size > 2_000_000:
            flush()
            batch_size = 0
        batch.append(snapshot)
        batch_size += size
    flush()


def run():
    handler = RotatingFileHandler(HOME / "agent.log", maxBytes=1_000_000, backupCount=2, encoding="utf-8")
    logging.basicConfig(level=logging.INFO, handlers=[handler],
                        format="%(asctime)s %(levelname)s %(message)s")
    remote = Remote()
    threading.Thread(target=poll, args=(remote,), daemon=True).start()
    pending = queue.Queue()
    observer = Observer()
    observer.start()
    active = {}
    last_roots = None
    next_registration_check = 0
    next_reconcile = 0
    known = {}
    dirty = {}
    full = set()
    LOGGER.info("Agent started")
    try:
        while True:
            time.sleep(0.6)
            current = registrations()
            for root_id in set(active) - set(current):
                observer.unschedule(active.pop(root_id))
                known.pop(root_id, None)
                dirty.pop(root_id, None)
                full.discard(root_id)
            now = time.monotonic()
            if now >= next_reconcile:
                full.update(current)
                next_reconcile = now + 900
            for root_id, record in current.items():
                if root_id not in active:
                    root = Path(record["path"])
                    try:
                        active[root_id] = observer.schedule(Changes(root_id, root, pending), str(root), recursive=True)
                        full.add(root_id)
                    except OSError:
                        continue
            while True:
                try:
                    root_id, relative = pending.get_nowait()
                except queue.Empty:
                    break
                if root_id in current:
                    dirty.setdefault(root_id, set()).add(relative)
            try:
                if current != last_roots or now >= next_registration_check:
                    result = remote.json("roots", list(current))
                    if isinstance(result, dict):
                        for item in result.get("revoked", []):
                            root_id, revision = item["root"], item["revision"]
                            if root_id in current and current[root_id].get("revision", "") == revision:
                                remember_revocation(root_id, revision)
                    full.update(key for key, value in current.items() if (last_roots or {}).get(key) != value)
                    last_roots = current
                    next_registration_check = now + 12
                    if registrations() != current:
                        continue
                for root_id in set(dirty) | full:
                    if root_id not in active:
                        continue
                    recursive = root_id in full
                    paths = [""] if recursive else sorted(
                        dirty[root_id], key=lambda path: (path.count("/") + bool(path), path), reverse=True
                    )
                    try:
                        sync_root(remote, root_id, current[root_id], paths, known.setdefault(root_id, {}), recursive)
                    except RegistrationRevoked:
                        continue
                    except (FileNotFoundError, PermissionError):
                        dirty.pop(root_id, None)
                        full.discard(root_id)
                        observer.unschedule(active.pop(root_id))
                        continue
                    dirty.pop(root_id, None)
                    full.discard(root_id)
            except (OSError, ValueError, http.client.HTTPException) as error:
                LOGGER.warning("Index update will retry: %s", error)
                full.update(current)
                time.sleep(3)
    finally:
        observer.stop()
        observer.join()


def main():
    ROOTS.mkdir(parents=True, exist_ok=True)
    parser = argparse.ArgumentParser(description="Personal File Portal for Windows")
    commands = parser.add_subparsers(dest="command", required=True)
    add = commands.add_parser("add")
    add.add_argument("path", nargs="?", default=".")
    add.add_argument("--name")
    remove = commands.add_parser("remove")
    remove.add_argument("path")
    commands.add_parser("list")
    commands.add_parser("status")
    commands.add_parser("run")
    args = parser.parse_args()
    if args.command == "run":
        with (HOME / "agent.lock").open("a+b") as lock:
            for _ in range(20):
                try:
                    msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
                except OSError:
                    time.sleep(0.25)
                else:
                    run()
                    return
    elif args.command == "list":
        print(json.dumps(list(registrations().values()), ensure_ascii=False, indent=2))
    elif args.command == "status":
        try:
            connected = Remote().json("status", timeout=4).get("online", False)
        except (OSError, ValueError, http.client.HTTPException):
            connected = False
        print("Online" if connected else "Offline")
        return 0 if connected else 1
    else:
        path = Path(args.path).resolve(strict=args.command == "add")
        root_id = registration_id(path)
        file = ROOTS / (root_id + ".json")
        if args.command == "remove":
            file.unlink(missing_ok=True)
            print(f"Removed: {path}")
            return
        if not path.is_dir() or reparse_or_link(path.lstat()):
            parser.error("Choose a regular directory.")
        if path == HOME or HOME.is_relative_to(path) or path.is_relative_to(HOME):
            parser.error("Choose a directory outside the portal's private settings.")
        name = (args.name or path.name or str(path)).strip()
        if not name or len(name) > 255:
            parser.error("Invalid display name.")
        temporary = file.with_suffix(f".{os.getpid()}.tmp")
        record = {"path": str(path), "name": name, "revision": secrets.token_hex(16)}
        temporary.write_text(json.dumps(record, ensure_ascii=False), encoding="utf-8")
        temporary.replace(file)
        print(f"Registered: {name} | {path}")


if __name__ == "__main__":
    raise SystemExit(main())
