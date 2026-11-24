"""Entry point of the local PDF processing backend.

Launched and supervised by the Electron main process. Binds to 127.0.0.1 on
an OS-assigned port, prints a single JSON "ready" line on stdout, and exits
when the parent process disappears. The auth token is passed through the
``PDFED_TOKEN`` environment variable (never on the command line).
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import socket
import sys
import threading
import time
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))


def _parent_watchdog(ppid: int) -> None:
    """Terminate when the Electron parent process is gone (no orphans)."""

    def alive(pid: int) -> bool:
        if sys.platform == "win32":
            import ctypes

            PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
            STILL_ACTIVE = 259
            h = ctypes.windll.kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
            if not h:
                return False
            code = ctypes.c_ulong()
            ctypes.windll.kernel32.GetExitCodeProcess(h, ctypes.byref(code))
            ctypes.windll.kernel32.CloseHandle(h)
            return code.value == STILL_ACTIVE
        try:
            os.kill(pid, 0)
            return True
        except OSError:
            return False

    while True:
        time.sleep(2)
        if not alive(ppid):
            try:  # do not leave job processes (OCR, conversion) behind
                from core.jobs import job_manager

                job_manager.shutdown()
            finally:
                os._exit(0)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--sessions-root", required=True)
    parser.add_argument("--assets", required=True)
    parser.add_argument("--cache-dir")
    parser.add_argument("--parent-pid", type=int)
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--max-revisions", type=int, default=60)
    parser.add_argument("--log-level", default="warning")
    args = parser.parse_args()

    token = os.environ.get("PDFED_TOKEN", "")
    if len(token) < 32:
        print(json.dumps({"event": "error", "message": "missing auth token"}), flush=True)
        sys.exit(2)

    from core.config import Settings, set_settings

    set_settings(Settings(
        sessions_root=Path(args.sessions_root),
        assets_dir=Path(args.assets),
        token=token,
        max_revisions=args.max_revisions,
        cache_dir=Path(args.cache_dir) if args.cache_dir else None,
    ))
    logging.basicConfig(level=getattr(logging, args.log_level.upper(), logging.WARNING),
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s", stream=sys.stderr)

    import uvicorn

    from api.app import create_app

    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1) if sys.platform != "win32" else None
    sock.bind(("127.0.0.1", args.port))  # loopback only - never exposed to the network
    port = sock.getsockname()[1]

    if args.parent_pid:
        threading.Thread(target=_parent_watchdog, args=(args.parent_pid,), daemon=True).start()

    app = create_app(token)
    config = uvicorn.Config(app, log_level=args.log_level, access_log=False, lifespan="on",
                            timeout_keep_alive=30)
    server = uvicorn.Server(config)
    print(json.dumps({"event": "ready", "port": port, "pid": os.getpid()}), flush=True)
    try:
        server.run(sockets=[sock])
    finally:
        from core.jobs import job_manager

        job_manager.shutdown()


if __name__ == "__main__":
    import multiprocessing

    multiprocessing.freeze_support()
    main()
