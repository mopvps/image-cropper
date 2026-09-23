import base64
import json
import mimetypes
import os
import re
import uuid
import zipfile
from io import BytesIO
from pathlib import Path

import fitz  # PyMuPDF
from flask import Flask, request, jsonify, send_file, render_template, abort
from PIL import Image, ImageFilter

app = Flask(__name__)


@app.errorhandler(Exception)
def handle_exception(e):
    import traceback
    return jsonify({"error": str(e), "trace": traceback.format_exc()}), 500


# Store sessions in memory — maps session_id to local paths
SESSIONS = {}

DPI = 200


def get_pdf_path(session_id):
    if session_id in SESSIONS:
        return Path(SESSIONS[session_id]["pdf_path"])
    return Path("")


def render_page_image(pdf_path, page_num, dpi=150):
    doc = fitz.open(pdf_path)
    if page_num < 1 or page_num > doc.page_count:
        doc.close()
        return None
    page = doc.load_page(page_num - 1)
    zoom = dpi / 72
    mat = fitz.Matrix(zoom, zoom)
    pix = page.get_pixmap(matrix=mat)
    img_bytes = pix.tobytes("png")
    doc.close()
    return Image.open(BytesIO(img_bytes))


def crop_pct(img, x_pct, y_pct, w_pct, h_pct):
    width, height = img.size
    left = int(width * x_pct / 100)
    top = int(height * y_pct / 100)
    right = int(left + width * w_pct / 100)
    bottom = int(top + height * h_pct / 100)

    left = max(0, min(left, width))
    top = max(0, min(top, height))
    right = max(0, min(right, width))
    bottom = max(0, min(bottom, height))

    return img.crop((left, top, right, bottom))


def trim_whitespace(img, threshold=240):
    """Auto-trim white/near-white border from image."""
    import numpy as np
    rgb = img.convert("RGB")
    arr = np.array(rgb)
    # Mask of non-white pixels
    mask = ~(
        (arr[:, :, 0] >= threshold) &
        (arr[:, :, 1] >= threshold) &
        (arr[:, :, 2] >= threshold)
    )
    rows = np.any(mask, axis=1)
    cols = np.any(mask, axis=0)
    if not rows.any() or not cols.any():
        return img  # fully white — return as-is
    top, bottom = np.where(rows)[0][[0, -1]]
    left, right = np.where(cols)[0][[0, -1]]
    # Add 2px padding so content doesn't touch edges
    top    = max(0, top - 2)
    left   = max(0, left - 2)
    bottom = min(img.height, bottom + 3)
    right  = min(img.width, right + 3)
    return img.crop((left, top, right, bottom))


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/config")
def config():
    config_path = Path(__file__).resolve().parent / "config.json"
    with open(config_path, "r", encoding="utf-8") as f:
        return jsonify(json.load(f))


@app.route("/process", methods=["POST"])
def process():
    data        = request.get_json(force=True)
    pdf_path    = data.get("pdf_path", "").strip()
    folder_path = data.get("folder_path", "").strip()

    if not pdf_path or not folder_path:
        return jsonify({"error": "pdf path and folder path required"}), 400

    pdf_path    = Path(pdf_path)
    folder_path = Path(folder_path)

    if not pdf_path.exists():
        return jsonify({"error": f"PDF not found: {pdf_path}"}), 400
    if not folder_path.exists():
        return jsonify({"error": f"Folder not found: {folder_path}"}), 400

    # Find xhtml file
    xhtml_path = None
    for ext in [".xhtml", ".html", ".xml"]:
        matches = list(folder_path.glob(f"*{ext}"))
        if matches:
            xhtml_path = matches[0]
            break

    if not xhtml_path:
        return jsonify({"error": "No .xhtml file found in folder"}), 400

    xhtml_text = xhtml_path.read_text(encoding="utf-8", errors="ignore")

    # Find images subfolder
    images_dir = None
    for name in ["images", "Images", "image", "Image", "img"]:
        candidate = folder_path / name
        if candidate.exists() and candidate.is_dir():
            images_dir = candidate
            break
    if images_dir is None:
        images_dir = folder_path

    # Existing images in folder
    IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".gif", ".svg", ".webp"}
    existing_images = [f.name for f in images_dir.iterdir()
                       if f.suffix.lower() in IMAGE_EXTS]

    # Images referenced in xhtml
    srcs = re.findall(r'src=["\']([^"\']+)["\']', xhtml_text, flags=re.IGNORECASE)
    filenames = []
    for s in srcs:
        name = os.path.basename(s)
        if name and name not in filenames:
            filenames.append(name)

    doc = fitz.open(pdf_path)
    page_count = doc.page_count
    doc.close()

    # Auto-detect highlighted PDF in same folder as the PDF
    highlighted_pdf = None
    search_dir = pdf_path.parent
    print(f"[DEBUG] Searching for highlighted PDF in: {search_dir}")
    for f in search_dir.iterdir():
        print(f"[DEBUG] Found file: {f.name}")
        if f.suffix.lower() == '.pdf' and '_highlighted' in f.name.lower():
            highlighted_pdf = str(f)
            print(f"[DEBUG] Matched highlighted PDF: {f.name}")
            break
    if not highlighted_pdf:
        print("[DEBUG] No highlighted PDF found.")

    session_id = str(uuid.uuid4())
    SESSIONS[session_id] = {
        "pdf_path":          str(pdf_path),
        "highlighted_path":  highlighted_pdf or "",
        "folder_path":       str(folder_path),
        "images_dir":        str(images_dir),
        "xhtml_path":        str(xhtml_path),
    }

    return jsonify({
        "session_id":      session_id,
        "images":          filenames,
        "existing_images": existing_images,
        "page_count":      page_count,
        "xhtml_url":       f"/xhtml-serve/{session_id}/{folder_path.name}/{xhtml_path.name}",
        "highlighted_pdf": highlighted_pdf,
    })


@app.route("/xhtml-serve/<session_id>/<path:filepath>")
def xhtml_serve(session_id, filepath):
    if session_id not in SESSIONS:
        abort(404)
    folder_path = Path(SESSIONS[session_id]["folder_path"])
    epub_root = folder_path.parent
    target = (epub_root / filepath).resolve()
    if not str(target).startswith(str(epub_root.resolve())) or not target.exists():
        abort(404)
    mimetype = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
    return send_file(target, mimetype=mimetype)


@app.route("/page/<session_id>/<int:page_num>")
def get_page(session_id, page_num):
    pdf_path = get_pdf_path(session_id)
    if not pdf_path.exists():
        abort(404)
    doc = fitz.open(pdf_path)
    if page_num < 1 or page_num > doc.page_count:
        doc.close()
        abort(404)
    page = doc.load_page(page_num - 1)
    zoom = DPI / 72
    mat = fitz.Matrix(zoom, zoom)
    pix = page.get_pixmap(matrix=mat)
    img_bytes = pix.tobytes("png")
    doc.close()
    return send_file(BytesIO(img_bytes), mimetype="image/png")


@app.route("/highlight-page/<session_id>/<int:page_num>")
def get_highlight_page(session_id, page_num):
    if session_id not in SESSIONS:
        abort(404)
    h_path = Path(SESSIONS[session_id].get("highlighted_path", ""))
    if not h_path.exists():
        abort(404)
    doc = fitz.open(h_path)
    if page_num < 1 or page_num > doc.page_count:
        doc.close()
        abort(404)
    page = doc.load_page(page_num - 1)
    zoom = DPI / 72
    mat = fitz.Matrix(zoom, zoom)
    pix = page.get_pixmap(matrix=mat)
    img_bytes = pix.tobytes("png")
    doc.close()
    return send_file(BytesIO(img_bytes), mimetype="image/png")


@app.route("/highlight-pdf/<session_id>")
def get_highlight_pdf(session_id):
    if session_id not in SESSIONS:
        abort(404)
    h_path = Path(SESSIONS[session_id].get("highlighted_path", ""))
    if not h_path.exists():
        abort(404)
    return send_file(h_path, mimetype="application/pdf")


@app.route("/crop", methods=["POST"])
def crop():
    data = request.get_json(force=True)
    session_id = data.get("session_id")
    page_num = int(data.get("page_num"))
    x_pct = float(data.get("x"))
    y_pct = float(data.get("y"))
    w_pct = float(data.get("w"))
    h_pct = float(data.get("h"))
    filename = data.get("filename")

    pdf_path = get_pdf_path(session_id)
    if session_id not in SESSIONS or not pdf_path.exists() or not filename:
        return jsonify({"error": "invalid request"}), 400

    dpi = 135 if "inline" in filename.lower() else 150
    img = render_page_image(pdf_path, page_num, dpi=dpi)
    if img is None:
        return jsonify({"error": "invalid page"}), 400

    cropped = crop_pct(img, x_pct, y_pct, w_pct, h_pct)
    cropped = trim_whitespace(cropped)
    cropped = cropped.filter(ImageFilter.UnsharpMask(radius=1, percent=150, threshold=3))

    out_dir  = Path(SESSIONS[session_id]["images_dir"])
    out_path = out_dir / filename
    cropped.save(out_path, dpi=(dpi, dpi))

    return jsonify({"success": True, "filename": filename})


@app.route("/crop-preview", methods=["POST"])
def crop_preview():
    data = request.get_json(force=True)
    session_id = data.get("session_id")
    page_num = int(data.get("page_num"))
    x_pct = float(data.get("x"))
    y_pct = float(data.get("y"))
    w_pct = float(data.get("w"))
    h_pct = float(data.get("h"))
    filename = data.get("filename", "")

    pdf_path = get_pdf_path(session_id)
    if session_id not in SESSIONS or not pdf_path.exists():
        return jsonify({"error": "invalid request"}), 400

    dpi = 135 if "inline" in filename.lower() else 150
    img = render_page_image(pdf_path, page_num, dpi=dpi)
    if img is None:
        return jsonify({"error": "invalid page"}), 400

    cropped = crop_pct(img, x_pct, y_pct, w_pct, h_pct)

    buf = BytesIO()
    cropped.save(buf, format="PNG")
    b64 = base64.b64encode(buf.getvalue()).decode("ascii")

    return jsonify({"image": f"data:image/png;base64,{b64}"})


@app.route("/trim-preview", methods=["POST"])
def trim_preview():
    data = request.get_json(force=True)
    session_id = data.get("session_id")
    page_num   = int(data.get("page_num"))
    x_pct      = float(data.get("x"))
    y_pct      = float(data.get("y"))
    w_pct      = float(data.get("w"))
    h_pct      = float(data.get("h"))
    refine_x   = float(data.get("refine_x", 0))
    refine_y   = float(data.get("refine_y", 0))
    refine_w   = float(data.get("refine_w", 100))
    refine_h   = float(data.get("refine_h", 100))
    filename   = data.get("filename", "")

    pdf_path = get_pdf_path(session_id)
    if session_id not in SESSIONS or not pdf_path.exists():
        return jsonify({"error": "invalid session"}), 400

    dpi     = 135 if "inline" in filename.lower() else 150
    img     = render_page_image(pdf_path, page_num, dpi=dpi)
    cropped = crop_pct(img, x_pct, y_pct, w_pct, h_pct)
    refined = crop_pct(cropped, refine_x, refine_y, refine_w, refine_h)
    trimmed = trim_whitespace(refined)

    buf = BytesIO()
    trimmed.save(buf, format="PNG")
    b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    return jsonify({"image": f"data:image/png;base64,{b64}"})


@app.route("/save-trimmed", methods=["POST"])
def save_trimmed():
    data       = request.get_json(force=True)
    session_id = data.get("session_id")
    filename   = data.get("filename")
    image_b64  = data.get("image_b64")

    if not session_id or not filename or not image_b64:
        return jsonify({"error": "invalid request"}), 400
    if session_id not in SESSIONS:
        return jsonify({"error": "session expired, please re-process"}), 400

    dpi = 135 if "inline" in filename.lower() else 150

    img_bytes = base64.b64decode(image_b64)
    img       = Image.open(BytesIO(img_bytes))

    out_dir  = Path(SESSIONS[session_id]["images_dir"])
    out_path = out_dir / filename
    img = img.filter(ImageFilter.UnsharpMask(radius=1, percent=150, threshold=3))
    img.save(out_path, dpi=(dpi, dpi))

    return jsonify({"success": True, "filename": filename})


@app.route("/crop-refine", methods=["POST"])
def crop_refine():
    data = request.get_json(force=True)
    session_id = data.get("session_id")
    page_num = int(data.get("page_num"))
    x_pct = float(data.get("x"))
    y_pct = float(data.get("y"))
    w_pct = float(data.get("w"))
    h_pct = float(data.get("h"))
    refine_x_pct = float(data.get("refine_x"))
    refine_y_pct = float(data.get("refine_y"))
    refine_w_pct = float(data.get("refine_w"))
    refine_h_pct = float(data.get("refine_h"))
    filename = data.get("filename")

    pdf_path = get_pdf_path(session_id)
    if session_id not in SESSIONS or not pdf_path.exists() or not filename:
        return jsonify({"error": "invalid request"}), 400

    dpi = 135 if "inline" in filename.lower() else 150
    img = render_page_image(pdf_path, page_num, dpi=dpi)
    if img is None:
        return jsonify({"error": "invalid page"}), 400

    cropped = crop_pct(img, x_pct, y_pct, w_pct, h_pct)
    refined = crop_pct(cropped, refine_x_pct, refine_y_pct, refine_w_pct, refine_h_pct)
    refined = refined.filter(ImageFilter.UnsharpMask(radius=1, percent=150, threshold=3))
    refined = trim_whitespace(refined)

    out_dir  = Path(SESSIONS[session_id]["images_dir"])
    out_path = out_dir / filename
    refined.save(out_path, dpi=(dpi, dpi))

    return jsonify({"success": True, "filename": filename})


@app.route("/trim-bounds", methods=["POST"])
def trim_bounds():
    import numpy as np
    data       = request.get_json(force=True)
    session_id = data.get("session_id")
    page_num   = int(data.get("page_num"))
    x_pct      = float(data.get("x"))
    y_pct      = float(data.get("y"))
    w_pct      = float(data.get("w"))
    h_pct      = float(data.get("h"))
    refine_x   = float(data.get("refine_x", 0))
    refine_y   = float(data.get("refine_y", 0))
    refine_w   = float(data.get("refine_w", 100))
    refine_h   = float(data.get("refine_h", 100))
    filename   = data.get("filename", "")

    pdf_path = get_pdf_path(session_id)
    if session_id not in SESSIONS or not pdf_path.exists():
        return jsonify({"error": "invalid session"}), 400

    dpi     = 135 if "inline" in filename.lower() else 150
    img     = render_page_image(pdf_path, page_num, dpi=dpi)
    cropped = crop_pct(img, x_pct, y_pct, w_pct, h_pct)
    refined = crop_pct(cropped, refine_x, refine_y, refine_w, refine_h)

    rgb = refined.convert("RGB")
    arr = np.array(rgb)
    threshold = 240
    mask = ~(
        (arr[:, :, 0] >= threshold) &
        (arr[:, :, 1] >= threshold) &
        (arr[:, :, 2] >= threshold)
    )
    rows = np.any(mask, axis=1)
    cols = np.any(mask, axis=0)
    if not rows.any() or not cols.any():
        return jsonify({"x": 0, "y": 0, "w": 100, "h": 100})

    top, bottom = np.where(rows)[0][[0, -1]]
    left, right  = np.where(cols)[0][[0, -1]]
    top    = max(0, top - 2)
    left   = max(0, left - 2)
    bottom = min(refined.height, bottom + 3)
    right  = min(refined.width,  right + 3)

    return jsonify({
        "x": left / refined.width  * 100,
        "y": top  / refined.height * 100,
        "w": (right - left)  / refined.width  * 100,
        "h": (bottom - top)  / refined.height * 100,
    })


@app.route("/browse", methods=["POST"])
def browse():
    import tkinter as tk
    from tkinter import filedialog
    data      = request.get_json(force=True)
    mode      = data.get("mode", "file")  # "file" or "folder"

    root = tk.Tk()
    root.withdraw()
    root.wm_attributes('-topmost', 1)

    if mode == "folder":
        path = filedialog.askdirectory(title="Select XHTML Folder")
    else:
        path = filedialog.askopenfilename(
            title="Select PDF File",
            filetypes=[("PDF Files", "*.pdf")]
        )

    root.destroy()

    if not path:
        return jsonify({"path": ""})
    return jsonify({"path": str(Path(path))})


@app.route("/search", methods=["POST"])
def search():
    data       = request.get_json(force=True)
    session_id = data.get("session_id")
    query      = data.get("query", "").strip()

    if not session_id or not query:
        return jsonify({"error": "invalid request"}), 400

    pdf_path = get_pdf_path(session_id)
    if not pdf_path.exists():
        return jsonify({"error": "session not found"}), 400

    doc = fitz.open(pdf_path)
    results = []
    for i, page in enumerate(doc):
        hits = page.search_for(query)
        if hits:
            results.append({
                "page": i + 1,
                "rects": [[r.x0, r.y0, r.x1, r.y1] for r in hits]
            })
    doc.close()

    return jsonify({"results": results})


@app.route("/delete-image", methods=["POST"])
def delete_image():
    data       = request.get_json(force=True)
    session_id = data.get("session_id")
    filename   = data.get("filename")

    if not session_id or not filename:
        return jsonify({"error": "invalid request"}), 400
    if session_id not in SESSIONS:
        return jsonify({"error": "session not found"}), 400

    # Delete image file from disk
    out_dir  = Path(SESSIONS[session_id]["images_dir"])
    out_path = out_dir / filename
    if out_path.exists():
        out_path.unlink()

    return jsonify({"success": True, "filename": filename})


@app.route("/delete-tag", methods=["POST"])
def delete_tag():
    data       = request.get_json(force=True)
    session_id = data.get("session_id")
    filename   = data.get("filename")

    if not session_id or not filename:
        return jsonify({"error": "invalid request"}), 400
    if session_id not in SESSIONS:
        return jsonify({"error": "session not found"}), 400

    # Remove <img> tag from XHTML only — file untouched
    xhtml_path = Path(SESSIONS[session_id]["xhtml_path"])
    xhtml_text = xhtml_path.read_text(encoding="utf-8", errors="ignore")
    pattern = rf'\s*<img\s[^>]*src=["\'][^"\']*{re.escape(filename)}["\'][^>]*/>\s*'
    updated = re.sub(pattern, '', xhtml_text, flags=re.IGNORECASE)
    xhtml_path.write_text(updated, encoding="utf-8")

    return jsonify({"success": True, "filename": filename})


@app.route("/get-xhtml", methods=["POST"])
def get_xhtml():
    data       = request.get_json(force=True)
    session_id = data.get("session_id")

    if not session_id or session_id not in SESSIONS:
        return jsonify({"error": "session not found"}), 400

    xhtml_path = Path(SESSIONS[session_id]["xhtml_path"])
    content    = xhtml_path.read_text(encoding="utf-8", errors="ignore")
    return jsonify({"success": True, "content": content})


@app.route("/save-xhtml", methods=["POST"])
def save_xhtml():
    data       = request.get_json(force=True)
    session_id = data.get("session_id")
    content    = data.get("content", "")

    if not session_id or session_id not in SESSIONS:
        return jsonify({"error": "session not found"}), 400

    xhtml_path = Path(SESSIONS[session_id]["xhtml_path"])
    xhtml_path.write_text(content, encoding="utf-8")
    return jsonify({"success": True})


@app.route("/insert-image", methods=["POST"])
def insert_image():
    data       = request.get_json(force=True)
    session_id = data.get("session_id")
    after_filename = data.get("after_filename")  # e.g. ch7-inline-22.png

    if not session_id or not after_filename:
        return jsonify({"error": "invalid request"}), 400
    if session_id not in SESSIONS:
        return jsonify({"error": "session not found"}), 400

    xhtml_path = Path(SESSIONS[session_id]["xhtml_path"])
    xhtml_text = xhtml_path.read_text(encoding="utf-8", errors="ignore")

    # Find all inline numbers in the entire XHTML to get the last used number
    all_numbers = re.findall(r'ch\w+-inline-(\d+)\.png', xhtml_text)
    if not all_numbers:
        return jsonify({"error": "no inline images found"}), 400

    last_num  = max(int(n) for n in all_numbers)
    new_num   = last_num + 1

    # Build new filename using same prefix as after_filename
    # e.g. ch7-inline-22.png -> prefix = ch7-inline
    prefix_match = re.match(r'(.+-inline)-\d+\.png', after_filename)
    if not prefix_match:
        return jsonify({"error": "filename pattern not recognized"}), 400

    prefix       = prefix_match.group(1)
    new_filename = f"{prefix}-{new_num:02d}.png"

    # Build the new img tag — match style from existing tag
    # Find the after_filename tag to copy its attributes
    src_base = after_filename  # just filename, src may have images/ prefix
    pattern  = rf'(<img\s[^>]*src=["\'][^"\']*{re.escape(after_filename)}["\'][^>]*/>)'
    match    = re.search(pattern, xhtml_text, re.IGNORECASE)

    if not match:
        return jsonify({"error": f"img tag for {after_filename} not found in XHTML"}), 400

    existing_tag = match.group(1)

    # Build new tag by replacing src filename only
    new_src = re.sub(re.escape(after_filename), new_filename, existing_tag)
    # Update alt if needed
    new_tag = new_src

    # Insert new tag right after the existing tag
    updated_xhtml = xhtml_text.replace(
        existing_tag,
        existing_tag + new_tag,
        1  # replace only first occurrence
    )

    xhtml_path.write_text(updated_xhtml, encoding="utf-8")

    return jsonify({
        "success":      True,
        "new_filename": new_filename,
    })


if __name__ == "__main__":
    app.run(port=5000, debug=True)

