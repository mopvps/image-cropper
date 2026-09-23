"""
launcher.py — ImageCropper Launcher
Uses GitHub API to always get latest files (no cache issue)
"""

import os
import sys
import threading
import webbrowser
import time
import urllib.request
import urllib.error
import json
import base64
from pathlib import Path
import tkinter as tk

# ── GitHub Config ──────────────────────────────────────────────────────────────
GITHUB_USER   = "mopvps"
GITHUB_REPO   = "image-cropper"
GITHUB_BRANCH = "main"
API_BASE      = f"https://api.github.com/repos/{GITHUB_USER}/{GITHUB_REPO}/contents"

TRACKED_FILES = [
    "app.py",
    "config.json",
    "templates/index.html",
    "static/app.js",
    "static/style.css",
    "static/logo.webp",
]

# ── Paths ──────────────────────────────────────────────────────────────────────
if getattr(sys, 'frozen', False):
    EXE_DIR = Path(sys.executable).parent
else:
    EXE_DIR = Path(__file__).parent

APP_DIR = EXE_DIR / "app_files"

# ── Theme ──────────────────────────────────────────────────────────────────────
T = {
    "bg":          "#F6F7F9",
    "surface":     "#FFFFFF",
    "surface2":    "#F1F3F6",
    "border":      "#E3E8EF",
    "accent":      "#2B3A9C",
    "accent_dark": "#1F2C7A",
    "pass":        "#4A7C3A",
    "fail":        "#B91C1C",
    "warn":        "#B45309",
    "text":        "#111827",
    "text2":       "#4B5563",
    "muted":       "#8A94A6",
}

SERVER_URL = "http://127.0.0.1:5000"


# ══════════════════════════════════════════════════════════════════════════════
# GitHub API Downloader
# ══════════════════════════════════════════════════════════════════════════════

def ensure_dirs():
    for f in TRACKED_FILES:
        (APP_DIR / f).parent.mkdir(parents=True, exist_ok=True)


def fetch_via_api(rel_path: str):
    """
    Fetch file content via GitHub API.
    Returns raw bytes or None on failure.
    Always returns LATEST commit — no cache.
    """
    url = f"{API_BASE}/{rel_path}?ref={GITHUB_BRANCH}"
    req = urllib.request.Request(
        url,
        headers={
            "Accept":     "application/vnd.github.v3+json",
            "User-Agent": "ImageCropper-Launcher",
        }
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            data = json.loads(r.read().decode("utf-8"))

        # API returns base64 encoded content
        content_b64 = data.get("content", "").replace("\n", "")
        return base64.b64decode(content_b64)

    except urllib.error.HTTPError as e:
        print(f"[API] HTTP {e.code} for {rel_path}")
        return None
    except Exception as e:
        print(f"[API] Error for {rel_path}: {e}")
        return None


def download_all(log_fn, progress_fn):
    total   = len(TRACKED_FILES)
    success = 0
    failed  = 0

    log_fn("📡  Fetching latest from GitHub API...", T["muted"])

    for i, rel_path in enumerate(TRACKED_FILES):
        local_path = APP_DIR / rel_path

        content = fetch_via_api(rel_path)

        if content:
            local_path.write_bytes(content)
            log_fn(f"  ✓  {rel_path}", T["pass"])
            success += 1
        else:
            if local_path.exists():
                log_fn(f"  ⚠  {rel_path}  (using local copy)", T["warn"])
            else:
                log_fn(f"  ✗  {rel_path}  FAILED — no local copy!", T["fail"])
                failed += 1

        progress_fn(int((i + 1) / total * 60))

    if failed:
        log_fn(f"⚠  {failed} file(s) could not be fetched", T["warn"])
    else:
        log_fn(f"✅  All {success} files downloaded (latest commit)!", T["pass"])

    return failed == 0


# ══════════════════════════════════════════════════════════════════════════════
# Tkinter UI
# ══════════════════════════════════════════════════════════════════════════════

class LauncherApp:
    def __init__(self):
        self.root = tk.Tk()
        self.root.title("ImageCropper — Launcher")
        self.root.resizable(False, False)
        self.root.configure(bg=T["bg"])
        self._center(420, 500)
        self._build_ui()
        self.root.protocol("WM_DELETE_WINDOW", self._quit)

    def _center(self, w, h):
        self.root.update_idletasks()
        sw = self.root.winfo_screenwidth()
        sh = self.root.winfo_screenheight()
        self.root.geometry(f"{w}x{h}+{(sw-w)//2}+{(sh-h)//2}")

    def _build_ui(self):
        # ── Header ────────────────────────────────────────────────────────────
        header = tk.Frame(self.root, bg=T["accent"], height=60)
        header.pack(fill="x")
        header.pack_propagate(False)

        tk.Label(header, text="⬛  ImageCropper",
                 bg=T["accent"], fg="#FFFFFF",
                 font=("Segoe UI", 14, "bold"), padx=20
                 ).pack(side="left", pady=14)

        tk.Label(header, text="VilPower",
                 bg=T["accent"], fg="#A0AEDE",
                 font=("Segoe UI", 9), padx=20
                 ).pack(side="right", pady=14)

        # ── Status ────────────────────────────────────────────────────────────
        sf = tk.Frame(self.root, bg=T["bg"], pady=10)
        sf.pack(fill="x")

        self.status_dot = tk.Label(sf, text="●", bg=T["bg"],
                                   fg=T["warn"], font=("Segoe UI", 11))
        self.status_dot.pack(side="left", padx=(20, 4))

        self.status_lbl = tk.Label(sf, text="Starting...",
                                   bg=T["bg"], fg=T["text2"],
                                   font=("Segoe UI", 10))
        self.status_lbl.pack(side="left")

        # ── Log box ───────────────────────────────────────────────────────────
        lf = tk.Frame(self.root, bg=T["surface"],
                      highlightbackground=T["border"], highlightthickness=1)
        lf.pack(fill="both", expand=True, padx=20, pady=(0, 12))

        self.log = tk.Text(lf, bg=T["surface"], fg=T["text"],
                           font=("Consolas", 10), relief="flat", bd=0,
                           state="disabled", wrap="word",
                           padx=12, pady=10, cursor="arrow")
        self.log.pack(fill="both", expand=True)

        self.log.tag_config("pass",   foreground=T["pass"])
        self.log.tag_config("fail",   foreground=T["fail"])
        self.log.tag_config("warn",   foreground=T["warn"])
        self.log.tag_config("accent", foreground=T["accent"])
        self.log.tag_config("muted",  foreground=T["muted"])
        self.log.tag_config("text",   foreground=T["text"])

        # ── Progress bar ──────────────────────────────────────────────────────
        pf = tk.Frame(self.root, bg=T["bg"])
        pf.pack(fill="x", padx=20, pady=(0, 12))

        self.prog_canvas = tk.Canvas(pf, height=6, bg=T["surface2"],
                                     highlightthickness=0, bd=0)
        self.prog_canvas.pack(fill="x")
        self.prog_bar = self.prog_canvas.create_rectangle(
            0, 0, 0, 6, fill=T["accent"], width=0)

        # ── Buttons ───────────────────────────────────────────────────────────
        bf = tk.Frame(self.root, bg=T["bg"])
        bf.pack(fill="x", padx=20, pady=(0, 16))

        self.open_btn = tk.Button(bf, text="🌐  Open Browser",
                                  bg=T["accent"], fg="#FFFFFF",
                                  font=("Segoe UI", 10, "bold"),
                                  relief="flat", bd=0,
                                  padx=18, pady=10, cursor="hand2",
                                  activebackground=T["accent_dark"],
                                  activeforeground="#FFFFFF",
                                  state="disabled",
                                  command=self._open_browser)
        self.open_btn.pack(side="left", fill="x", expand=True, padx=(0, 8))

        tk.Button(bf, text="✕  Quit",
                  bg=T["surface2"], fg=T["text2"],
                  font=("Segoe UI", 10), relief="flat", bd=0,
                  padx=18, pady=10, cursor="hand2",
                  command=self._quit
                  ).pack(side="right")

        # ── Footer ────────────────────────────────────────────────────────────
        tk.Label(self.root,
                 text=f"github.com/{GITHUB_USER}/{GITHUB_REPO}",
                 bg=T["bg"], fg=T["muted"], font=("Segoe UI", 8)
                 ).pack(pady=(0, 10))

    # ── Helpers ───────────────────────────────────────────────────────────────

    def _log(self, msg, color=None):
        tag = {T["pass"]: "pass", T["fail"]: "fail", T["warn"]: "warn",
               T["accent"]: "accent", T["muted"]: "muted"}.get(color, "text")
        def _do():
            self.log.configure(state="normal")
            self.log.insert("end", msg + "\n", tag)
            self.log.see("end")
            self.log.configure(state="disabled")
        self.root.after(0, _do)

    def _set_status(self, text, color):
        self.root.after(0, lambda: [
            self.status_lbl.configure(text=text),
            self.status_dot.configure(fg=color)
        ])

    def _set_progress(self, pct):
        def _do():
            w = self.prog_canvas.winfo_width()
            self.prog_canvas.coords(self.prog_bar, 0, 0, w * pct / 100, 6)
        self.root.after(0, _do)

    def _open_browser(self):
        webbrowser.open(SERVER_URL)

    def _quit(self):
        os._exit(0)

    def _enable_open(self):
        self.root.after(0, lambda: self.open_btn.configure(state="normal"))

    # ── Main Sequence ─────────────────────────────────────────────────────────

    def _sequence(self):
        # 1. Download via API
        ensure_dirs()
        self._set_status("Fetching from GitHub API...", T["warn"])
        ok = download_all(self._log, self._set_progress)

        if not ok:
            self._set_status("Some files missing!", T["fail"])

        # 2. Start Flask
        self._set_progress(70)
        self._set_status("Starting server...", T["warn"])
        self._log("🚀  Starting Flask server...", T["accent"])

        try:
            sys.path.insert(0, str(APP_DIR))
            os.chdir(APP_DIR)
            from app import app as flask_app

            self._set_progress(100)
            self._set_status(f"Running  •  {SERVER_URL}", T["pass"])
            self._enable_open()
            self._log(f"✅  Server ready → {SERVER_URL}", T["pass"])

            threading.Thread(
                target=lambda: (time.sleep(1.2), webbrowser.open(SERVER_URL)),
                daemon=True
            ).start()

            flask_app.run(host="127.0.0.1", port=5000,
                          debug=False, use_reloader=False)

        except Exception as e:
            self._log(f"❌  {e}", T["fail"])
            self._set_status("Server error!", T["fail"])

    def run(self):
        threading.Thread(target=self._sequence, daemon=True).start()
        self.root.mainloop()


# ══════════════════════════════════════════════════════════════════════════════
if __name__ == "__main__":
    LauncherApp().run()