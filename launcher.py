"""
launcher.py — ImageCropper Launcher
Tkinter UI + GitHub auto-updater + Flask server
"""

import os
import sys
import threading
import webbrowser
import time
import urllib.request
import hashlib
from pathlib import Path
import tkinter as tk
from tkinter import font as tkfont

# ── GitHub Config ──────────────────────────────────────────────────────────────
GITHUB_USER   = "mopvps"
GITHUB_REPO   = "image-cropper"
GITHUB_BRANCH = "main"
RAW_BASE      = f"https://raw.githubusercontent.com/{GITHUB_USER}/{GITHUB_REPO}/{GITHUB_BRANCH}"

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

# ── VilPower Theme ─────────────────────────────────────────────────────────────
THEME = {
    "bg":          "#F6F7F9",
    "surface":     "#FFFFFF",
    "surface2":    "#F1F3F6",
    "border":      "#E3E8EF",
    "accent":      "#2B3A9C",
    "accent_dark": "#1F2C7A",
    "pass":        "#4A7C3A",
    "pass_soft":   "#F0F7ED",
    "fail":        "#B91C1C",
    "fail_soft":   "#FEF2F2",
    "warn":        "#B45309",
    "text":        "#111827",
    "text2":       "#4B5563",
    "muted":       "#8A94A6",
}

SERVER_URL = "http://127.0.0.1:5000"
flask_thread = None


# ══════════════════════════════════════════════════════════════════════════════
# Updater logic
# ══════════════════════════════════════════════════════════════════════════════

def ensure_dirs():
    for f in TRACKED_FILES:
        (APP_DIR / f).parent.mkdir(parents=True, exist_ok=True)


def file_sha256(path: Path) -> str:
    if not path.exists():
        return ""
    h = hashlib.sha256()
    h.update(path.read_bytes())
    return h.hexdigest()


def fetch_remote(url: str):
    try:
        with urllib.request.urlopen(url, timeout=10) as r:
            content = r.read()
        return hashlib.sha256(content).hexdigest(), content
    except Exception as e:
        return "", b""


def run_update(log_fn):
    """Check GitHub and update changed files. log_fn(msg, color) for UI."""
    log_fn("Checking for updates...", THEME["muted"])
    updated = 0
    failed  = 0
    for rel_path in TRACKED_FILES:
        url        = f"{RAW_BASE}/{rel_path}"
        local_path = APP_DIR / rel_path
        remote_hash, content = fetch_remote(url)
        if not content:
            log_fn(f"  ⚠  Could not reach {rel_path}", THEME["warn"])
            failed += 1
            continue
        local_hash = file_sha256(local_path)
        if remote_hash != local_hash:
            local_path.write_bytes(content)
            log_fn(f"  ↓  Updated: {rel_path}", THEME["accent"])
            updated += 1
        else:
            log_fn(f"  ✓  OK: {rel_path}", THEME["pass"])

    if failed and updated == 0:
        log_fn("⚠  Running with local files (no internet)", THEME["warn"])
    elif updated:
        log_fn(f"✅  {updated} file(s) updated!", THEME["pass"])
    else:
        log_fn("✅  Already up to date", THEME["pass"])


def start_flask(log_fn, ready_fn):
    """Start Flask in a background thread."""
    try:
        sys.path.insert(0, str(APP_DIR))
        os.chdir(APP_DIR)
        from app import app
        log_fn("🚀  Starting server...", THEME["accent"])
        ready_fn()
        app.run(host="127.0.0.1", port=5000, debug=False, use_reloader=False)
    except Exception as e:
        log_fn(f"❌  Server error: {e}", THEME["fail"])


# ══════════════════════════════════════════════════════════════════════════════
# Tkinter UI
# ══════════════════════════════════════════════════════════════════════════════

class LauncherApp:
    def __init__(self):
        self.root = tk.Tk()
        self.root.title("ImageCropper — Launcher")
        self.root.resizable(False, False)
        self.root.configure(bg=THEME["bg"])
        self._center(420, 520)
        self._build_ui()
        self.root.protocol("WM_DELETE_WINDOW", self._quit)

    def _center(self, w, h):
        self.root.update_idletasks()
        sw = self.root.winfo_screenwidth()
        sh = self.root.winfo_screenheight()
        x  = (sw - w) // 2
        y  = (sh - h) // 2
        self.root.geometry(f"{w}x{h}+{x}+{y}")

    def _build_ui(self):
        T = THEME
        r = self.root

        # ── Header ────────────────────────────────────────────────────────────
        header = tk.Frame(r, bg=T["accent"], height=64)
        header.pack(fill="x")
        header.pack_propagate(False)

        tk.Label(
            header,
            text="⬛  ImageCropper",
            bg=T["accent"], fg="#FFFFFF",
            font=("Segoe UI", 15, "bold"),
            padx=20,
        ).pack(side="left", pady=16)

        tk.Label(
            header,
            text="VilPower",
            bg=T["accent"], fg="#A0AEDE",
            font=("Segoe UI", 9),
            padx=20,
        ).pack(side="right", pady=16)

        # ── Status badge ──────────────────────────────────────────────────────
        badge_frame = tk.Frame(r, bg=T["bg"], pady=14)
        badge_frame.pack(fill="x")

        self.status_dot = tk.Label(
            badge_frame, text="●",
            bg=T["bg"], fg=T["warn"],
            font=("Segoe UI", 11)
        )
        self.status_dot.pack(side="left", padx=(20, 4))

        self.status_label = tk.Label(
            badge_frame,
            text="Initializing...",
            bg=T["bg"], fg=T["text2"],
            font=("Segoe UI", 10)
        )
        self.status_label.pack(side="left")

        # ── Log box ───────────────────────────────────────────────────────────
        log_frame = tk.Frame(r, bg=T["surface"], bd=0, highlightbackground=T["border"], highlightthickness=1)
        log_frame.pack(fill="both", expand=True, padx=20, pady=(0, 14))

        self.log_box = tk.Text(
            log_frame,
            bg=T["surface"], fg=T["text"],
            font=("Consolas", 10),
            relief="flat", bd=0,
            state="disabled",
            wrap="word",
            padx=12, pady=10,
            cursor="arrow",
            selectbackground=T["accent"],
        )
        self.log_box.pack(fill="both", expand=True)

        # tag colors
        self.log_box.tag_config("accent", foreground=T["accent"])
        self.log_box.tag_config("pass",   foreground=T["pass"])
        self.log_box.tag_config("warn",   foreground=T["warn"])
        self.log_box.tag_config("fail",   foreground=T["fail"])
        self.log_box.tag_config("muted",  foreground=T["muted"])
        self.log_box.tag_config("text",   foreground=T["text"])

        # scrollbar
        sb = tk.Scrollbar(log_frame, command=self.log_box.yview, bg=T["surface2"])
        self.log_box.configure(yscrollcommand=sb.set)

        # ── Progress bar (canvas) ─────────────────────────────────────────────
        self.progress_frame = tk.Frame(r, bg=T["bg"])
        self.progress_frame.pack(fill="x", padx=20, pady=(0, 14))

        self.progress_canvas = tk.Canvas(
            self.progress_frame,
            height=6, bg=T["surface2"],
            highlightthickness=0, bd=0
        )
        self.progress_canvas.pack(fill="x")
        self.progress_bar = self.progress_canvas.create_rectangle(
            0, 0, 0, 6, fill=T["accent"], width=0
        )
        self._progress_anim = 0

        # ── Buttons ───────────────────────────────────────────────────────────
        btn_frame = tk.Frame(r, bg=T["bg"])
        btn_frame.pack(fill="x", padx=20, pady=(0, 20))

        self.open_btn = tk.Button(
            btn_frame,
            text="🌐  Open Browser",
            bg=T["accent"], fg="#FFFFFF",
            font=("Segoe UI", 10, "bold"),
            relief="flat", bd=0,
            padx=18, pady=10,
            cursor="hand2",
            activebackground=T["accent_dark"],
            activeforeground="#FFFFFF",
            state="disabled",
            command=self._open_browser,
        )
        self.open_btn.pack(side="left", fill="x", expand=True, padx=(0, 8))

        self.quit_btn = tk.Button(
            btn_frame,
            text="✕  Quit",
            bg=T["surface2"], fg=T["text2"],
            font=("Segoe UI", 10),
            relief="flat", bd=0,
            padx=18, pady=10,
            cursor="hand2",
            activebackground=T["fail_soft"],
            activeforeground=T["fail"],
            command=self._quit,
        )
        self.quit_btn.pack(side="right")

        # ── Footer ────────────────────────────────────────────────────────────
        tk.Label(
            r,
            text=f"github.com/{GITHUB_USER}/{GITHUB_REPO}",
            bg=T["bg"], fg=T["muted"],
            font=("Segoe UI", 8),
        ).pack(pady=(0, 10))

    # ── Helpers ───────────────────────────────────────────────────────────────

    def _log(self, msg, color=None):
        """Append a line to the log box (thread-safe)."""
        def _do():
            self.log_box.configure(state="normal")
            tag = {
                THEME["accent"]: "accent",
                THEME["pass"]:   "pass",
                THEME["warn"]:   "warn",
                THEME["fail"]:   "fail",
                THEME["muted"]:  "muted",
            }.get(color, "text")
            self.log_box.insert("end", msg + "\n", tag)
            self.log_box.see("end")
            self.log_box.configure(state="disabled")
        self.root.after(0, _do)

    def _set_status(self, text, color):
        def _do():
            self.status_label.configure(text=text)
            self.status_dot.configure(fg=color)
        self.root.after(0, _do)

    def _set_progress(self, pct):
        """pct: 0-100"""
        def _do():
            w = self.progress_canvas.winfo_width()
            self.progress_canvas.coords(self.progress_bar, 0, 0, w * pct / 100, 6)
        self.root.after(0, _do)

    def _animate_progress(self):
        """Indeterminate progress animation while loading."""
        if self._progress_anim < 0:
            return
        self._progress_anim = (self._progress_anim + 2) % 101
        self._set_progress(self._progress_anim)
        self.root.after(20, self._animate_progress)

    def _open_browser(self):
        webbrowser.open(SERVER_URL)

    def _quit(self):
        self._log("Shutting down...", THEME["muted"])
        self.root.after(300, self.root.destroy)
        os._exit(0)

    def _enable_open_btn(self):
        def _do():
            self.open_btn.configure(state="normal")
            self._progress_anim = -1          # stop animation
            self._set_progress(100)
            self._set_status("Server running  •  " + SERVER_URL, THEME["pass"])
        self.root.after(0, _do)

    # ── Main sequence ─────────────────────────────────────────────────────────

    def _run_sequence(self):
        """Runs in a background thread."""
        ensure_dirs()

        # 1. Update
        self._set_status("Checking for updates...", THEME["warn"])
        run_update(self._log)
        self._set_progress(60)

        # 2. Flask
        self._set_status("Starting server...", THEME["warn"])

        def on_ready():
            self._enable_open_btn()
            time.sleep(1.2)
            webbrowser.open(SERVER_URL)

        start_flask(self._log, on_ready)   # blocks until server stops

    def run(self):
        self._set_status("Starting...", THEME["warn"])
        self._animate_progress()
        t = threading.Thread(target=self._run_sequence, daemon=True)
        t.start()
        self.root.mainloop()


# ══════════════════════════════════════════════════════════════════════════════
if __name__ == "__main__":
    LauncherApp().run()