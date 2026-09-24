/* ══════════════════════════════════════════════════════════
   1. STATE VARIABLES
   ══════════════════════════════════════════════════════════ */
let cmEditor = null; // CodeMirror instance
let cmSearchCursor = null;
let cmSearchQuery  = '';
let cmSearchMatches = [];
let cmSearchIndex  = -1;

let hasHighlightedPdf = false;
let viewingHighlight  = false;

let pdfZoom   = 1;
let xhtmlZoom = 1;
const ZOOM_MIN  = 0.25;
const ZOOM_MAX  = 3;
const ZOOM_STEP = 0.1;
let cropMode = false;
let sessionId = null;
let images = [];
let existingImages = [];
let croppedSet = new Set();
let pageCount = 0;
let rect = null;          // { page_num, x, y, w, h } in canvas px, for the active page
let activePageNum = null; // which page canvas is being dragged
let dragging = false;
let startX = 0, startY = 0;
let selectedImage = null; // filename chosen via chip click — crop save target
const pageImages = {};    // page_num -> Image object (for redraw on clear)
const savedCrops = {};    // page_num -> [{x, y, w, h, filename}]

const DPI = 150;

let searchResults = [];   // array of { page, rects }
let searchIndex   = 0;    // current result index

let activePanel = null; // 'pdf' or 'xhtml'

let selectionEditBtn = null;
let lastSelectedText = null;
let lastSelectionContext = null;

let tooltipTarget = null;     // filename the tooltip is acting on
let tooltipJustOpened = false;

/* Crop refine modal state */
let modalImg = null;
let modalOriginalCrop = null; // { page_num, x, y, w, h } percentages from stage 1
let modalFilename = null;
let modalBox = null;          // { x, y, w, h } in canvas px — refine rect
let modalDragHandle = null;   // one of nw,n,ne,e,se,s,sw,w or null
let modalDragging = false;
let modalDragStart = { x: 0, y: 0 };
let modalBoxStart = null;
const HANDLE_SIZE = 10;

/* ══════════════════════════════════════════════════════════
   2. ELEMENT REFERENCES
   ══════════════════════════════════════════════════════════ */
const uploadBtn = document.getElementById('uploadBtn');
const uploadingText = document.getElementById('uploadingText');
const emptyState = document.getElementById('emptyState');
const pagesContainer = document.getElementById('pagesContainer');
const xhtmlFrame = document.getElementById('xhtmlFrame');
const html = document.documentElement;

const cropModal = document.getElementById('cropModal');
const cropModalCanvas = document.getElementById('cropModalCanvas');
const cropModalCtx = cropModalCanvas.getContext('2d');

/* ══════════════════════════════════════════════════════════
   3. FUNCTION DEFINITIONS
   ══════════════════════════════════════════════════════════ */

function toggleCropMode() {
  cropMode = !cropMode;
  const btn = document.getElementById('cropModeBtn');
  if (cropMode) {
    btn.textContent = 'Alt+C: Crop ON';
    btn.style.background = 'var(--accent-soft)';
    btn.style.borderColor = 'var(--accent)';
    btn.style.color = 'var(--accent)';
    // Set all canvases to crosshair
    document.querySelectorAll('.pdf-page canvas').forEach(c => c.style.cursor = 'crosshair');
  } else {
    btn.textContent = 'Alt+C: Crop OFF';
    btn.style.background = 'var(--surface-2)';
    btn.style.borderColor = 'var(--border)';
    btn.style.color = 'var(--muted)';
    // Set all canvases to default (scrollable/normal)
    document.querySelectorAll('.pdf-page canvas').forEach(c => c.style.cursor = 'default');
    clearCropSelection();
  }
}

function createTooltip() {
  const tip = document.createElement('div');
  tip.id = 'chipTooltip';
  tip.style.cssText = `
    position:fixed; z-index:9999; display:none;
    background:var(--surface); border:1px solid var(--border);
    border-radius:8px; box-shadow:0 4px 16px rgba(0,0,0,0.15);
    padding:4px; min-width:130px; font-family:'Inter',sans-serif;
  `;
  tip.innerHTML = `
    <div id="tipRecrop" style="padding:8px 12px;font-size:12px;cursor:pointer;
      border-radius:6px;color:var(--text);display:flex;align-items:center;gap:8px;">
      ✂ Re-crop
    </div>
    <div id="tipInsert" style="padding:8px 12px;font-size:12px;cursor:pointer;
      border-radius:6px;color:var(--accent);display:flex;align-items:center;gap:8px;">
      ➕ Insert After
    </div>
    <div id="tipDelete" style="padding:8px 12px;font-size:12px;cursor:pointer;
      border-radius:6px;color:var(--fail);display:flex;align-items:center;gap:8px;">
      🗑 Delete Image
    </div>
    <div id="tipDeleteTag" style="padding:8px 12px;font-size:12px;cursor:pointer;
      border-radius:6px;color:var(--warn);display:flex;align-items:center;gap:8px;">
      🏷 Delete Tag
    </div>
  `;
  document.body.appendChild(tip);

  // Hover styles
  tip.querySelectorAll('div').forEach(el => {
    el.addEventListener('mouseenter', () => el.style.background = 'var(--surface-2)');
    el.addEventListener('mouseleave', () => el.style.background = '');
  });

  // Hide on outside click
  document.addEventListener('click', e => {
    if (tooltipJustOpened) return;
    if (!tip.contains(e.target)) hideTooltip();
  });

  tip.querySelector('#tipRecrop').addEventListener('click', () => {
    const name = tooltipTarget;
    hideTooltip();
    if (!name) return;
    selectedImage = name;
    croppedSet.delete(name);
    existingImages = existingImages.filter(n => n !== name);
    // Remove saved crop overlay for this image
    for (const pageNum in savedCrops) {
      savedCrops[pageNum] = savedCrops[pageNum].filter(c => c.filename !== name);
      redrawPage(parseInt(pageNum));
    }
    renderChips();
    showToast(`Draw a new crop box for: ${name}`, 'warn');
    if (!cropMode) toggleCropMode();
  });

  tip.querySelector('#tipInsert').addEventListener('click', async () => {
    const name = tooltipTarget;
    hideTooltip();
    if (!name) return;

    try {
      const res  = await fetch('/insert-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId, after_filename: name })
      });
      const data = await res.json();
      if (data.error) { showToast(data.error, 'fail'); return; }

      const newFilename = data.new_filename;

      // Add to images list and chips
      const idx = images.indexOf(name);
      if (idx !== -1) {
        images.splice(idx + 1, 0, newFilename);
      } else {
        images.push(newFilename);
      }

      // Auto select the new image for cropping
      selectedImage = newFilename;
      renderChips();

      // Refresh XHTML iframe to show new tag (cache-busted)
      setTimeout(() => refreshXhtml(), 100);

      // Scroll new chip into view
      setTimeout(() => {
        const chip = [...document.querySelectorAll('.chip')]
          .find(c => c.title === newFilename);
        if (chip) chip.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }, 200);

      showToast(`➕ Inserted: ${newFilename} — now draw crop box`, 'pass');

      // Auto enable crop mode
      if (!cropMode) toggleCropMode();

    } catch(e) {
      showToast('Insert failed: ' + e.message, 'fail');
    }
  });

  tip.querySelector('#tipDelete').addEventListener('click', async () => {
    const name = tooltipTarget;
    hideTooltip();
    if (!name) return;
    if (!confirm(`Delete "${name}" from disk?`)) return;
    try {
      const res  = await fetch('/delete-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId, filename: name })
      });
      const data = await res.json();
      if (data.error) { showToast(data.error, 'fail'); return; }
      croppedSet.delete(name);
      existingImages = existingImages.filter(n => n !== name);
      // Do NOT remove from images array — keep chip visible as unlinked
      if (selectedImage === name) selectedImage = null;
      selectedImage = name; // auto-select it for re-cropping

      // Remove green box from PDF
      for (const pageNum in savedCrops) {
        savedCrops[pageNum] = savedCrops[pageNum].filter(c => c.filename !== name);
        redrawPage(parseInt(pageNum));
      }

      renderChips();
      refreshXhtml();
      showToast(`🗑 Deleted: ${name}`, 'warn');
    } catch(e) {
      showToast('Delete failed: ' + e.message, 'fail');
    }
  });

  tip.querySelector('#tipDeleteTag').addEventListener('click', async () => {
    const name = tooltipTarget;
    hideTooltip();
    if (!name) return;
    if (!confirm(`Remove <img> tag for "${name}" from XHTML? File stays on disk.`)) return;
    try {
      const res = await fetch('/delete-tag', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId, filename: name })
      });
      const data = await res.json();
      if (data.error) { showToast(data.error, 'fail'); return; }
      images = images.filter(n => n !== name);
      if (selectedImage === name) selectedImage = null;
      renderChips();
      refreshXhtml();
      showToast(`🏷 Tag removed: ${name}`, 'warn');
    } catch(e) {
      showToast('Delete tag failed: ' + e.message, 'fail');
    }
  });

  return tip;
}

function showTooltip(e, name) {
  if (e.preventDefault) e.preventDefault();
  if (e.stopPropagation) e.stopPropagation();
  tooltipTarget = name;
  chipTooltip.style.display = 'block';

  const x = Math.min(e.clientX, window.innerWidth  - 150);
  const y = Math.min(e.clientY, window.innerHeight - 90);
  chipTooltip.style.left = x + 'px';
  chipTooltip.style.top  = y + 'px';

  // Prevent immediate close from the click that opened it
  tooltipJustOpened = true;
  setTimeout(() => { tooltipJustOpened = false; }, 100);
}

function hideTooltip() {
  chipTooltip.style.display = 'none';
  tooltipTarget = null;
}

function refreshXhtml() {
  const frame = document.getElementById('xhtmlFrame');
  try {
    const iframeDoc = frame.contentDocument || frame.contentWindow.document;
    const scrollY = frame.contentWindow.scrollY || 0;
    const scrollX = frame.contentWindow.scrollX || 0;

    frame.addEventListener('load', function restoreScroll() {
      try {
        frame.contentWindow.scrollTo(scrollX, scrollY);
      } catch(e) {}
      frame.removeEventListener('load', restoreScroll);
    });

    const base = frame.src.split('?')[0];
    frame.src = base + '?t=' + Date.now();
  } catch(e) {
    const base = xhtmlFrame.src.split('?')[0];
    xhtmlFrame.src = base + '?t=' + Date.now();
  }
}

function setActivePanel(panel) {
  activePanel = panel;

  const pdfPanel   = document.getElementById('middle-left');
  const xhtmlPanel = document.getElementById('middle-right');

  pdfPanel.style.outline   = panel === 'pdf'   ? '2px solid var(--accent)' : 'none';
  xhtmlPanel.style.outline = panel === 'xhtml' ? '2px solid var(--accent)' : 'none';
  pdfPanel.style.outlineOffset   = '-2px';
  xhtmlPanel.style.outlineOffset = '-2px';
}

async function browseFile(mode, targetId) {
  try {
    const res = await fetch('/browse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode })
    });
    const data = await res.json();
    if (data.path) {
      document.getElementById(targetId).value = data.path;
      if (targetId === 'pdfPath') {
        const name = data.path.split(/[\\/]/).pop();
        document.getElementById('pdfName').textContent = name;
        document.getElementById('pdfWrap').classList.add('file-ready');
      } else {
        const name = data.path.split(/[\\/]/).pop();
        document.getElementById('xhtmlName').textContent = name;
        document.getElementById('xhtmlWrap').classList.add('file-ready');
      }
      checkUploadReady();
    }
  } catch (e) {
    showToast('Browse failed: ' + e.message, 'fail');
  }
}

function checkUploadReady() {
  const hasPdf    = document.getElementById('pdfPath').value.trim();
  const hasFolder = document.getElementById('folderPath').value.trim();
  uploadBtn.disabled = !(hasPdf && hasFolder);
}

async function doSearch() {
  const query = document.getElementById('searchInput').value.trim();
  if (!query || !sessionId) return;

  // Clear previous highlights
  searchResults.forEach(r => redrawPage(r.page));
  searchResults = [];
  searchIndex   = 0;

  try {
    const res  = await fetch('/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, query })
    });
    const data = await res.json();
    if (data.error) { showToast(data.error, 'fail'); return; }

    searchResults = data.results;
    if (!searchResults.length) {
      document.getElementById('searchCount').textContent = 'Not found';
      return;
    }

    // Highlight all matches on their pages
    searchResults.forEach(r => highlightSearch(r));

    // Jump to first result
    searchIndex = 0;
    jumpToSearch(0);

  } catch(e) {
    showToast('Search failed: ' + e.message, 'fail');
  }
}

function highlightSearch(result) {
  const canvas = pagesContainer.querySelector(`canvas[data-page="${result.page}"]`);
  const img    = pageImages[result.page];
  if (!canvas || !img) return;

  const ctx  = canvas.getContext('2d');
  const scaleX = canvas.width  / img.naturalWidth  || 1;
  const scaleY = canvas.height / img.naturalHeight || 1;

  // Use DPI scale: canvas is rendered at 150dpi from 72dpi PDF points
  const dpiScale = DPI / 72;

  ctx.save();
  result.rects.forEach(([x0, y0, x1, y1]) => {
    ctx.fillStyle = 'rgba(255, 200, 0, 0.4)';
    ctx.fillRect(x0 * dpiScale, y0 * dpiScale,
                 (x1 - x0) * dpiScale, (y1 - y0) * dpiScale);
    ctx.strokeStyle = 'rgba(200, 140, 0, 0.8)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x0 * dpiScale, y0 * dpiScale,
                   (x1 - x0) * dpiScale, (y1 - y0) * dpiScale);
  });
  ctx.restore();
}

function jumpToSearch(index) {
  if (!searchResults.length) return;
  const result = searchResults[index];
  const pageEl = pagesContainer.querySelector(`.pdf-page[data-page="${result.page}"]`);
  if (pageEl) pageEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
  const total = searchResults.reduce((sum, r) => sum + r.rects.length, 0);
  document.getElementById('searchCount').textContent =
    `${index + 1}/${searchResults.length} pages (${total} hits)`;
}

function showViewer() {
  emptyState.style.display = 'none';
  pagesContainer.style.display = 'flex';
}

/* ── PDF Zoom ── */
function applyPdfZoom() {
  pagesContainer.style.transform       = `scale(${pdfZoom})`;
  pagesContainer.style.transformOrigin = 'top center';
  // Expand container so scrollbar appears correctly
  const naturalH = pagesContainer.scrollHeight / pdfZoom;
  pagesContainer.style.height      = `${naturalH * pdfZoom}px`;
  pagesContainer.style.marginBottom = `${(pdfZoom - 1) * naturalH}px`;
  document.getElementById('pdfZoomLevel').textContent = Math.round(pdfZoom * 100) + '%';
}

function setPdfZoom(delta) {
  pdfZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, parseFloat((pdfZoom + delta).toFixed(2))));
  applyPdfZoom();
}

/* ── XHTML Zoom ── */
function applyXhtmlZoom() {
  const frame = document.getElementById('xhtmlFrame');
  const pct   = Math.round(xhtmlZoom * 100) + '%';
  // Scale the iframe element itself — works cross-origin and survives reload
  frame.style.transform       = `scale(${xhtmlZoom})`;
  frame.style.transformOrigin = 'top left';
  frame.style.width           = `${100 / xhtmlZoom}%`;
  frame.style.height          = `${100 / xhtmlZoom}%`;
  document.getElementById('xhtmlZoomLevel').textContent = pct;
}

function setXhtmlZoom(delta) {
  xhtmlZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, parseFloat((xhtmlZoom + delta).toFixed(2))));
  applyXhtmlZoom();
}

/* ── Chips ── */
function renderChips() {
  const chips = document.getElementById('chips');
  chips.innerHTML = '';

  if (!images || images.length === 0) {
    chips.innerHTML = '<span style="font-size:12px;color:var(--muted)">No images in XHTML</span>';
    return;
  }

  images.forEach(name => {
    const existsInFolder = existingImages.includes(name);
    const isCropped = croppedSet.has(name);

    const chip = document.createElement('span');
    chip.title = name;
    chip.textContent = (isCropped ? '✓ ' : '') + name;

    if (isCropped) {
      chip.className = 'chip done';
    } else if (existsInFolder) {
      chip.className = 'chip linked';
    } else {
      chip.className = 'chip unlinked';
    }
    if (name === selectedImage) chip.classList.add('selected');

    chip.addEventListener('contextmenu', e => showTooltip(e, name));

    chip.addEventListener('click', () => {
      selectedImage = (selectedImage === name) ? null : name;
      renderChips();

      if (selectedImage && activePageNum) {
        const activeCanvas = pagesContainer.querySelector(
          `.pdf-page[data-page="${activePageNum}"]`
        );
        if (activeCanvas) {
          activeCanvas.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }

      if (selectedImage) {
        try {
          const iframeDoc = xhtmlFrame.contentDocument || xhtmlFrame.contentWindow.document;
          const imgs = iframeDoc.querySelectorAll('img');
          for (const img of imgs) {
            const imgName = img.getAttribute('src').split('/').pop().split('?')[0];
            if (imgName === selectedImage) {
              img.scrollIntoView({ behavior: 'smooth', block: 'center' });
              // Optional: briefly highlight the image
              img.style.outline = '3px solid #2B3A9C';
              setTimeout(() => { img.style.outline = ''; }, 1500);
              break;
            }
          }
        } catch(e) {
          console.warn('iframe scroll failed', e);
        }
      }
    });

    chips.appendChild(chip);
  });

  const saveStatus = document.getElementById('saveStatus');
  if (saveStatus) saveStatus.textContent = croppedSet.size > 0 ? `✓ ${croppedSet.size} images saved to folder` : '';

  const existCount = images.filter(n => existingImages.includes(n)).length;
  const chipsCount = document.getElementById('chips-count');
  if (chipsCount) chipsCount.textContent = existCount + '/' + images.length;
}

/* ── Refresh cropped list ── */
function refreshCroppedList(filename) {
  if (filename) croppedSet.add(filename);
  renderChips();
}

/* ── Build stacked page canvases ── */
function buildPages() {
  pagesContainer.innerHTML = '';

  for (let n = 1; n <= pageCount; n++) {
    const pageDiv = document.createElement('div');
    pageDiv.className = 'pdf-page';
    pageDiv.dataset.page = n;

    const canvas = document.createElement('canvas');
    canvas.dataset.page = n;
    canvas.style.cursor = 'default';

    pageDiv.appendChild(canvas);
    pagesContainer.appendChild(pageDiv);

    const img = new Image();
    img.onload = () => {
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      pageImages[n] = img;
    };
    img.src = `/page/${sessionId}/${n}?t=${Date.now()}`;

    attachCropHandlers(canvas, n);
  }
}

function drawSavedCrops(pageNum) {
  const canvas = pagesContainer.querySelector(`canvas[data-page="${pageNum}"]`);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const crops = savedCrops[pageNum] || [];
  crops.forEach(({ x, y, w, h }) => {
    ctx.fillStyle = 'rgba(74,124,58,0.18)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = '#4A7C3A';
    ctx.lineWidth = 2;
    ctx.setLineDash([]);
    ctx.strokeRect(x, y, w, h);
  });
}

function redrawPage(n) {
  const canvas = pagesContainer.querySelector(`canvas[data-page="${n}"]`);
  const img = pageImages[n];
  if (!canvas || !img) return;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0);
  drawSavedCrops(n);
}

/* ── Per-page crop drawing ── */
function attachCropHandlers(canvas, pageNum) {
  canvas.addEventListener('mousedown', e => {
    if (!cropMode) return;
    const r = canvas.getBoundingClientRect();
    const sx = canvas.width / r.width;
    const sy = canvas.height / r.height;
    startX = (e.clientX - r.left) * sx;
    startY = (e.clientY - r.top) * sy;
    dragging = true;
    activePageNum = pageNum;
    rect = null;
    document.querySelectorAll('.pdf-page').forEach(p => p.classList.remove('active-crop'));
    canvas.closest('.pdf-page').classList.add('active-crop');
  });

  canvas.addEventListener('mousemove', e => {
    if (!cropMode || !dragging || activePageNum !== pageNum) return;
    const r = canvas.getBoundingClientRect();
    const sx = canvas.width / r.width;
    const sy = canvas.height / r.height;
    const curX = (e.clientX - r.left) * sx;
    const curY = (e.clientY - r.top) * sy;

    redrawPage(pageNum);
    const ctx = canvas.getContext('2d');

    const x = Math.min(startX, curX);
    const y = Math.min(startY, curY);
    const w = Math.abs(curX - startX);
    const h = Math.abs(curY - startY);

    ctx.fillStyle = 'rgba(43,58,156,0.15)';
    ctx.fillRect(x, y, w, h);

    ctx.strokeStyle = '#2B3A9C';
    ctx.setLineDash([6, 3]);
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);

    ctx.fillStyle = '#2B3A9C';
    [[x,y],[x+w,y],[x,y+h],[x+w,y+h]].forEach(([cx,cy]) => {
      ctx.beginPath();
      ctx.arc(cx, cy, 5, 0, Math.PI*2);
      ctx.fill();
    });

    rect = { page_num: pageNum, x, y, w, h };
  });

  canvas.addEventListener('mouseup', () => { dragging = false; });
  canvas.addEventListener('mouseleave', () => { dragging = false; });

  canvas.addEventListener('click', e => {
    if (cropMode) return; // ignore clicks in crop mode
    const r = canvas.getBoundingClientRect();
    const sx = canvas.width / r.width;
    const sy = canvas.height / r.height;
    const px = (e.clientX - r.left) * sx;
    const py = (e.clientY - r.top) * sy;

    const crops = savedCrops[pageNum] || [];
    for (const crop of crops) {
      if (px >= crop.x && px <= crop.x + crop.w &&
          py >= crop.y && py <= crop.y + crop.h) {
        showToast(crop.filename, 'pass');
        return;
      }
    }
  });
}

/* ── Controls: Enter to save, Escape to clear ── */
function clearCropSelection() {
  if (activePageNum) redrawPage(activePageNum);
  document.querySelectorAll('.pdf-page').forEach(p => p.classList.remove('active-crop'));
  rect = null;
  activePageNum = null;
}

async function saveCrop() {
  const filename = selectedImage;
  if (!filename) { showToast('Click a chip to select an image filename first', 'warn'); return; }
  if (!rect || rect.w < 5 || rect.h < 5) { showToast('Draw a crop box first', 'warn'); return; }
  const savedRect = { ...rect }; // capture before any async/null

  const canvas = pagesContainer.querySelector(`canvas[data-page="${rect.page_num}"]`);
  const xPct = rect.x / canvas.width * 100;
  const yPct = rect.y / canvas.height * 100;
  const wPct = rect.w / canvas.width * 100;
  const hPct = rect.h / canvas.height * 100;

  try {
    const res = await fetch('/crop-preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, page_num: rect.page_num, x: xPct, y: yPct, w: wPct, h: hPct, filename: filename })
    });
    const data = await res.json();
    if (data.error) { showToast(data.error, 'fail'); return; }

    openCropModal(data.image, { page_num: rect.page_num, x: xPct, y: yPct, w: wPct, h: hPct }, filename);
  } catch (e) {
    showToast('Preview failed: ' + e.message, 'fail');
  }
}

function handlePositions(box) {
  const { x, y, w, h } = box;
  return {
    nw: [x, y], n: [x + w / 2, y], ne: [x + w, y],
    e: [x + w, y + h / 2], se: [x + w, y + h],
    s: [x + w / 2, y + h], sw: [x, y + h], w: [x, y + h / 2],
  };
}

function openCropModal(dataUrl, originalCrop, filename) {
  modalOriginalCrop = originalCrop;
  modalFilename = filename;

  modalImg = new Image();
  modalImg.onload = () => {
    const maxW = window.innerWidth * 0.95;
    const maxH = window.innerHeight * 0.92;
    let dw = modalImg.naturalWidth;
    let dh = modalImg.naturalHeight;
    const scale = Math.min(1, maxW / dw, maxH / dh);
    dw = Math.round(dw * scale);
    dh = Math.round(dh * scale);

    // Canvas = cropped image + 10px padding on each side
    const PAD = 10;
    cropModalCanvas.width = dw + PAD * 2;
    cropModalCanvas.height = dh + PAD * 2;

    // Draw image centered with 10px offset
    modalImg._pad = PAD;
    modalImg._dw = dw;
    modalImg._dh = dh;

    modalBox = { x: PAD, y: PAD, w: dw, h: dh };

    cropModal.style.display = 'flex';
    drawModalCanvas();

    // Auto-trigger trim after image is ready
    setTimeout(() => {
      document.getElementById('cropModalTrim').click();
    }, 50);
  };
  modalImg.src = dataUrl;
}

function closeCropModal() {
  cropModal.style.display = 'none';
  modalImg = null;
  modalOriginalCrop = null;
  modalFilename = null;
  modalBox = null;
  modalDragHandle = null;
  modalDragging = false;
}

function drawModalCanvas() {
  const w = cropModalCanvas.width;
  const h = cropModalCanvas.height;
  cropModalCtx.clearRect(0, 0, w, h);
  const pad = modalImg._pad || 0;
  const iw = modalImg._dw || w;
  const ih = modalImg._dh || h;
  // Fill padding area with checkerboard to show it's outside
  cropModalCtx.fillStyle = '#e0e0e0';
  cropModalCtx.fillRect(0, 0, w, h);
  cropModalCtx.drawImage(modalImg, modalImg._pad || 0, modalImg._pad || 0, modalImg._dw || w, modalImg._dh || h);

  // Dim outside crop box
  cropModalCtx.fillStyle = 'rgba(0,0,0,0.45)';
  cropModalCtx.fillRect(0, 0, w, modalBox.y);
  cropModalCtx.fillRect(0, modalBox.y + modalBox.h, w, h - modalBox.y - modalBox.h);
  cropModalCtx.fillRect(0, modalBox.y, modalBox.x, modalBox.h);
  cropModalCtx.fillRect(modalBox.x + modalBox.w, modalBox.y, w - modalBox.x - modalBox.w, modalBox.h);

  // Dashed border
  cropModalCtx.strokeStyle = '#2B3A9C';
  cropModalCtx.setLineDash([6, 3]);
  cropModalCtx.lineWidth = 2;
  cropModalCtx.strokeRect(modalBox.x, modalBox.y, modalBox.w, modalBox.h);
  cropModalCtx.setLineDash([]);

  // Handles
  cropModalCtx.fillStyle = '#2B3A9C';
  Object.values(handlePositions(modalBox)).forEach(([hx, hy]) => {
    cropModalCtx.beginPath();
    cropModalCtx.arc(hx, hy, 5, 0, Math.PI * 2);
    cropModalCtx.fill();
  });
}

function hitTestHandle(px, py) {
  const positions = handlePositions(modalBox);
  for (const [name, [hx, hy]] of Object.entries(positions)) {
    if (Math.abs(px - hx) <= HANDLE_SIZE && Math.abs(py - hy) <= HANDLE_SIZE) return name;
  }
  return null;
}

function canvasPoint(e) {
  const r = cropModalCanvas.getBoundingClientRect();
  const sx = cropModalCanvas.width / r.width;
  const sy = cropModalCanvas.height / r.height;
  return { x: (e.clientX - r.left) * sx, y: (e.clientY - r.top) * sy };
}

function initSelectionEdit() {
  selectionEditBtn = document.getElementById('selectionEditBtn');

  selectionEditBtn.addEventListener('click', async () => {
    selectionEditBtn.style.display = 'none';
    if (!lastSelectedText || !sessionId) return;

    // Open XHTML editor
    const editor = document.getElementById('xhtmlEditor');
    const frame  = document.getElementById('xhtmlFrame');

    // If editor not open yet, open it
    if (editor.style.display === 'none' || editor.style.display === '') {
      await toggleXhtmlEdit();
    }

    // Wait for editor to be populated
    setTimeout(() => {
      const content = editor.value;

      // Try to find using context (surrounding text)
      let searchStr = lastSelectionContext || lastSelectedText;
      let idx = content.indexOf(searchStr);

      // Fallback to just selected text
      if (idx === -1 && lastSelectionContext !== lastSelectedText) {
        idx = content.indexOf(lastSelectedText);
        searchStr = lastSelectedText;
      }

      if (idx === -1) {
        showToast('Could not locate selection in source', 'warn');
        return;
      }

      // Find the selected text within the context
      const selOffset = searchStr.indexOf(lastSelectedText);
      const start = idx + (selOffset >= 0 ? selOffset : 0);
      const end   = start + lastSelectedText.length;

      // Scroll textarea to the position
      editor.focus();
      editor.setSelectionRange(start, end);

      // Scroll to line
      const lines = content.substring(0, start).split('\n');
      const lineHeight = 19; // ~12px font * 1.6 line-height
      editor.scrollTop = Math.max(0, (lines.length - 5)) * lineHeight;

      showToast('✓ Selection highlighted in editor', 'pass');
    }, 150);
  });

  // Listen for text selection inside the iframe
  xhtmlFrame.addEventListener('load', () => {
    try {
      const doc = xhtmlFrame.contentDocument || xhtmlFrame.contentWindow.document;
      doc.addEventListener('mouseup', onIframeMouseUp);
      doc.addEventListener('keyup',   onIframeMouseUp);
    } catch(e) {}
  });
}

function onIframeMouseUp() {
  try {
    const doc = xhtmlFrame.contentDocument || xhtmlFrame.contentWindow.document;
    const sel = doc.getSelection();
    const text = sel ? sel.toString().trim() : '';

    if (!text || text.length < 2) {
      selectionEditBtn.style.display = 'none';
      lastSelectedText = null;
      lastSelectionContext = null;
      return;
    }

    lastSelectedText = text;

    // Grab surrounding context (~60 chars around selection) for better matching
    try {
      const range    = sel.getRangeAt(0);
      const container = range.startContainer;
      const fullText  = container.textContent || '';
      const offset    = range.startOffset;
      const ctxStart  = Math.max(0, offset - 30);
      const ctxEnd    = Math.min(fullText.length, offset + text.length + 30);
      lastSelectionContext = fullText.substring(ctxStart, ctxEnd);
    } catch(e) {
      lastSelectionContext = text;
    }

    // Position the floating button near selection
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    const frameRect = xhtmlFrame.getBoundingClientRect();
    const x = frameRect.left + rect.left + rect.width / 2 - 30;
    const y = frameRect.top  + rect.top  - 36;

    selectionEditBtn.style.left    = Math.max(0, x) + 'px';
    selectionEditBtn.style.top     = Math.max(0, y) + 'px';
    selectionEditBtn.style.display = 'block';
  } catch(e) {
    selectionEditBtn.style.display = 'none';
  }
}

// Hide button on click outside iframe
document.addEventListener('mousedown', e => {
  if (selectionEditBtn && e.target !== selectionEditBtn) {
    selectionEditBtn.style.display = 'none';
  }
});

/* ── Header: app name + tabs from /config ── */
async function loadConfig() {
  try {
    const res = await fetch('/config');
    const cfg = await res.json();

    const brandLabel = document.getElementById('header-brand-label');
    if (brandLabel) brandLabel.textContent = cfg.app_name || '';

    const tabsNav = document.getElementById('header-tabs');
    tabsNav.innerHTML = '';

    const enabledTools = (cfg.tools || []).filter(t => t.enabled);
    if (enabledTools.length <= 1) {
      tabsNav.style.display = 'none';
      return;
    }
    tabsNav.style.display = '';

    enabledTools.forEach(tool => {
      const btn = document.createElement('button');
      btn.className = 'tab' + (tool.default ? ' active' : '');
      btn.textContent = tool.label;
      btn.addEventListener('click', () => {
        if (tool.url) window.location = tool.url;
      });
      tabsNav.appendChild(btn);
    });
  } catch (e) {
    // config unavailable — leave header minimal
  }
}

/* ── Toast ── */
function showToast(msg, type = 'pass') {
  let toast = document.getElementById('toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toast';
    toast.style.cssText = `
      position:fixed;bottom:24px;right:24px;
      padding:10px 18px;border-radius:8px;font-size:13px;font-family:'Inter',sans-serif;
      font-weight:500;z-index:9999;box-shadow:0 4px 16px rgba(0,0,0,.18);
      transition:opacity .3s;
    `;
    document.body.appendChild(toast);
  }
  const colors = {
    pass: ['#F0F7ED','#4A7C3A','#B8D9AB'],
    fail: ['#FEF2F2','#B91C1C','#FBBFBF'],
    warn: ['#FFFBEB','#B45309','#FDE68A'],
  };
  const [bg, color, border] = colors[type] || colors.pass;
  toast.style.background = bg;
  toast.style.color = color;
  toast.style.border = `1px solid ${border}`;
  toast.textContent = msg;
  toast.style.opacity = '1';
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { toast.style.opacity = '0'; }, 2800);
}

/* ══════════════════════════════════════════════════════════
   4. ELEMENT EVENT LISTENERS & WIRING
   ══════════════════════════════════════════════════════════ */

document.getElementById('cropModeBtn')?.addEventListener('click', toggleCropMode);

document.getElementById('searchBtn').addEventListener('click', doSearch);

document.getElementById('searchNext').addEventListener('click', () => {
  if (!searchResults.length) return;
  searchIndex = (searchIndex + 1) % searchResults.length;
  jumpToSearch(searchIndex);
});

document.getElementById('searchPrev').addEventListener('click', () => {
  if (!searchResults.length) return;
  searchIndex = (searchIndex - 1 + searchResults.length) % searchResults.length;
  jumpToSearch(searchIndex);
});

document.getElementById('searchInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') doSearch();
});

// Ctrl+F focuses search box instead of browser find
document.addEventListener('keydown', e => {
  if (e.ctrlKey && e.key === 'f') {
    e.preventDefault();
    if (activePanel === 'xhtml') {
      // Focus xhtml iframe and trigger browser native find
      xhtmlFrame.contentWindow.focus();
    } else {
      // Focus PDF search box
      document.getElementById('searchInput').focus();
      document.getElementById('searchInput').select();
    }
  }
});

document.getElementById('middle-left').addEventListener('mousedown', () => {
  setActivePanel('pdf');
});

document.getElementById('middle-right').addEventListener('mousedown', () => {
  setActivePanel('xhtml');
});

xhtmlFrame.addEventListener('load', () => {
  try {
    const iframeDoc = xhtmlFrame.contentDocument || xhtmlFrame.contentWindow.document;
    iframeDoc.addEventListener('mousedown', () => {
      setActivePanel('xhtml');
    });
  } catch(e) {}
});

/* ── File path inputs ── */
document.getElementById('pdfPath').addEventListener('input', checkUploadReady);
document.getElementById('folderPath').addEventListener('input', checkUploadReady);

/* ── Upload ── */
uploadBtn.onclick = async () => {
  const pdfPath    = document.getElementById('pdfPath').value.trim();
  const folderPath = document.getElementById('folderPath').value.trim();

  uploadBtn.disabled = true;
  uploadingText.style.display = 'block';
  uploadingText.textContent = 'Processing...';

  try {
    const res = await fetch('/process', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pdf_path: pdfPath, folder_path: folderPath })
    });
    const data = await res.json();
    if (data.error) { alert(data.error); return; }

    sessionId      = data.session_id;
    images         = data.images || [];
    existingImages = data.existing_images || [];
    pageCount      = data.page_count;
    hasHighlightedPdf = !!data.highlighted_pdf;
    viewingHighlight  = false;
    const hlBtn = document.getElementById('highlightToggleBtn');
    if (hasHighlightedPdf) {
      hlBtn.style.display = 'inline-flex';
      hlBtn.textContent   = '📄 Original';
    } else {
      hlBtn.style.display = 'none';
    }
    croppedSet     = new Set();
    rect           = null;
    activePageNum  = null;

    xhtmlFrame.src = data.xhtml_url;
    selectedImage  = null;
    renderChips();
    buildPages();
    showViewer();

    searchResults = [];
    searchIndex   = 0;
    document.getElementById('searchCount').textContent = '';
    document.getElementById('searchInput').value = '';

    uploadingText.textContent = `✓ ${images.length} images found · ${pageCount} pages`;
  } catch (e) {
    alert('Process failed: ' + e.message);
  } finally {
    uploadBtn.disabled = false;
  }
};

// After xhtmlFrame loads, inject click handlers on all <img> tags
xhtmlFrame.addEventListener('load', () => {
  try {
    const iframeDoc = xhtmlFrame.contentDocument || xhtmlFrame.contentWindow.document;
    // Ensure relative paths resolve from epub_root
    if (!iframeDoc.querySelector('base') && xhtmlFrame.src) {
      const base = iframeDoc.createElement('base');
      base.href = xhtmlFrame.src.substring(0, xhtmlFrame.src.lastIndexOf('/') + 1);
      iframeDoc.head.prepend(base);
    }
    iframeDoc.querySelectorAll('img').forEach(img => {
      img.style.cursor = 'pointer';
      img.addEventListener('click', () => {
        const src = img.getAttribute('src');
        const name = src.split('/').pop().split('?')[0];

        // Match against images list
        const match = images.find(n => n === name);
        if (match) {
          selectedImage = match;
          renderChips();
          // Scroll chip into view
          const chip = [...document.querySelectorAll('.chip')]
            .find(c => c.title === match);
          if (chip) chip.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
      });
      img.addEventListener('contextmenu', e => {
        e.preventDefault();
        const src  = img.getAttribute('src');
        const name = src.split('/').pop().split('?')[0];
        const match = images.find(n => n === name);
        if (!match) return;

        // Convert iframe coords to main page coords
        const frameRect = xhtmlFrame.getBoundingClientRect();
        const mainX = frameRect.left + e.clientX;
        const mainY = frameRect.top  + e.clientY;

        // Create a fake event-like object with main page coords
        const fakeE = {
          preventDefault: () => {},
          stopPropagation: () => {},
          clientX: mainX,
          clientY: mainY,
        };
        showTooltip(fakeE, match);
      });
    });
    iframeDoc.addEventListener('contextmenu', e => e.preventDefault());
    iframeDoc.addEventListener('click', () => {
      if (!tooltipJustOpened) hideTooltip();
    });
  } catch(e) {
    console.warn('iframe access failed', e);
  }
});

/* ── Theme toggle ── */
document.getElementById('theme-toggle').onclick = () => {
  const isDark = html.getAttribute('data-theme') === 'dark';
  html.setAttribute('data-theme', isDark ? 'light' : 'dark');
  document.getElementById('theme-toggle').querySelector('.theme-label').textContent = isDark ? 'Dark' : 'Light';
  cmEditor?.setOption('theme', html.dataset.theme === 'dark' ? 'midnight' : 'default');
};

function toggleRightSidebar() {
  const right = document.getElementById('right');
  const btn = document.getElementById('rightToggleBtn');
  const isCollapsed = right.classList.toggle('right-collapsed');
  btn.textContent = isCollapsed ? '‹' : '›';
  btn.title = isCollapsed ? 'Expand Images Panel (Ctrl+Shift+Enter)' : 'Collapse Images Panel (Ctrl+Shift+Enter)';
}

function toggleFullscreen() {
  const isFull = document.body.classList.toggle('fullscreen-mode');
  document.getElementById('fullscreenIcon').textContent = isFull ? '✕' : '⛶';
  document.getElementById('fullscreenLabel').textContent = isFull ? 'Exit Fullscreen' : 'Fullscreen';
  document.getElementById('fullscreenBtn').title = isFull ? 'Exit Fullscreen (Alt+Enter)' : 'Fullscreen (Alt+Enter)';
}

document.addEventListener('keydown', e => {
  if (cropModal.style.display !== 'none') return; // modal has its own key handling
  if (document.activeElement === document.getElementById('xhtmlEditor')) return; // editing XHTML
  if (e.altKey && e.key === 'c') { e.preventDefault(); toggleCropMode(); return; }
  if (e.altKey && e.key === 'Enter') { e.preventDefault(); toggleFullscreen(); return; }
  if (e.ctrlKey && e.shiftKey && e.key === 'Enter') { e.preventDefault(); toggleRightSidebar(); return; }
  if (e.key === 'Escape') {
    if (document.body.classList.contains('fullscreen-mode')) { toggleFullscreen(); return; }
    // Clear search highlights
    if (searchResults.length) {
      searchResults.forEach(r => redrawPage(r.page));
      searchResults = [];
      searchIndex   = 0;
      document.getElementById('searchCount').textContent = '';
      document.getElementById('searchInput').value = '';
    }
    // Clear crop selection if in crop mode
    if (cropMode) clearCropSelection();
    return;
  }
  if (!cropMode) return;
  if (e.key === 'Enter') saveCrop();
});

cropModalCanvas.addEventListener('mousedown', e => {
  if (!modalBox) return;
  const p = canvasPoint(e);
  const handle = hitTestHandle(p.x, p.y);
  if (handle) {
    modalDragHandle = handle;
  } else {
    const insideBox = p.x >= modalBox.x && p.x <= modalBox.x + modalBox.w &&
                      p.y >= modalBox.y && p.y <= modalBox.y + modalBox.h;
    modalDragHandle = insideBox ? 'move' : 'new';
  }
  modalDragging = true;
  modalDragStart = p;
  modalBoxStart = { ...modalBox };
});

cropModalCanvas.addEventListener('mousemove', e => {
  const p = canvasPoint(e);
  const w = cropModalCanvas.width;
  const h = cropModalCanvas.height;

  if (!modalDragging) {
    // Update cursor
    const handle = hitTestHandle(p.x, p.y);
    if (handle) {
      cropModalCanvas.style.cursor = 'pointer';
    } else {
      const inside = p.x >= modalBox.x && p.x <= modalBox.x + modalBox.w &&
                     p.y >= modalBox.y && p.y <= modalBox.y + modalBox.h;
      cropModalCanvas.style.cursor = inside ? 'move' : 'crosshair';
    }
    return;
  }

  const dx = p.x - modalDragStart.x;
  const dy = p.y - modalDragStart.y;
  let { x, y, w: bw, h: bh } = modalBoxStart;
  const right = x + bw;
  const bottom = y + bh;

  if (modalDragHandle === 'move') {
    let nx = Math.max(0, Math.min(modalBoxStart.x + dx, w - bw));
    let ny = Math.max(0, Math.min(modalBoxStart.y + dy, h - bh));
    modalBox = { x: nx, y: ny, w: bw, h: bh };

  } else if (modalDragHandle === 'new') {
    const nx = Math.max(0, Math.min(modalDragStart.x, p.x));
    const ny = Math.max(0, Math.min(modalDragStart.y, p.y));
    modalBox = {
      x: nx, y: ny,
      w: Math.min(Math.abs(p.x - modalDragStart.x), w - nx),
      h: Math.min(Math.abs(p.y - modalDragStart.y), h - ny)
    };

  } else {
    // Handle resize (existing logic)
    if (modalDragHandle.includes('w')) { x = modalBoxStart.x + dx; bw = right - x; }
    if (modalDragHandle.includes('e')) { bw = modalBoxStart.w + dx; }
    if (modalDragHandle.includes('n')) { y = modalBoxStart.y + dy; bh = bottom - y; }
    if (modalDragHandle.includes('s')) { bh = modalBoxStart.h + dy; }
    x = Math.max(0, Math.min(x, w));
    y = Math.max(0, Math.min(y, h));
    bw = Math.max(10, Math.min(bw, w - x));
    bh = Math.max(10, Math.min(bh, h - y));
    modalBox = { x, y, w: bw, h: bh };
  }

  drawModalCanvas();
});

cropModalCanvas.addEventListener('mouseup', () => {
  modalDragging = false; modalDragHandle = null;
});
cropModalCanvas.addEventListener('mouseleave', () => {
  modalDragging = false; modalDragHandle = null;
});

document.getElementById('cropModalTrim').onclick = async () => {
  if (!modalBox || !modalOriginalCrop) return;

  const btn = document.getElementById('cropModalTrim');
  btn.disabled = true;
  btn.textContent = 'Trimming...';

  const pad = modalImg._pad || 0;
  const iw  = modalImg._dw;
  const ih  = modalImg._dh;
  const refineXPct = Math.max(0, (modalBox.x - pad)) / iw * 100;
  const refineYPct = Math.max(0, (modalBox.y - pad)) / ih * 100;
  const refineWPct = Math.min(modalBox.w, iw - Math.max(0, modalBox.x - pad)) / iw * 100;
  const refineHPct = Math.min(modalBox.h, ih - Math.max(0, modalBox.y - pad)) / ih * 100;

  try {
    const res = await fetch('/trim-bounds', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: sessionId,
        page_num:   modalOriginalCrop.page_num,
        x:          modalOriginalCrop.x,
        y:          modalOriginalCrop.y,
        w:          modalOriginalCrop.w,
        h:          modalOriginalCrop.h,
        refine_x:   refineXPct,
        refine_y:   refineYPct,
        refine_w:   refineWPct,
        refine_h:   refineHPct,
        filename:   modalFilename,
      })
    });
    const data = await res.json();
    if (data.error) { showToast(data.error, 'fail'); return; }

    // Move crop box only — image stays untouched
    const newX = modalBox.x + (data.x / 100 * modalBox.w);
    const newY = modalBox.y + (data.y / 100 * modalBox.h);
    const newW = data.w / 100 * modalBox.w;
    const newH = data.h / 100 * modalBox.h;

    modalBox = { x: newX, y: newY, w: newW, h: newH };
    modalOriginalCrop._trim_refine = { x: data.x, y: data.y, w: data.w, h: data.h };

    drawModalCanvas();
    showToast('✓ Trimmed — adjust if needed then Save', 'pass');

  } catch (e) {
    showToast('Trim failed: ' + e.message, 'fail');
  } finally {
    btn.disabled = false;
    btn.textContent = '✂ Auto Trim';
  }
};

document.getElementById('cropModalClose').onclick = closeCropModal;
document.getElementById('cropModalCancel').onclick = closeCropModal;

document.getElementById('cropModalSave').onclick = async () => {
  if (!modalBox || !modalOriginalCrop || !modalFilename) return;

  // If auto-trimmed, save the trimmed+adjusted region directly
  if (modalOriginalCrop?._trimmed_b64) {
    const btn = document.getElementById('cropModalSave');
    btn.disabled = true;
    btn.textContent = 'Saving...';

    // Apply any user adjustments on top of trimmed image
    const offscreenCanvas = document.createElement('canvas');
    offscreenCanvas.width  = modalImg._dw;
    offscreenCanvas.height = modalImg._dh;
    const offCtx = offscreenCanvas.getContext('2d');
    offCtx.drawImage(modalImg, 0, 0, modalImg._dw, modalImg._dh);

    const pad = modalImg._pad || 0;
    const scaleX = modalImg._dw / cropModalCanvas.width;
    const scaleY = modalImg._dh / cropModalCanvas.height;
    const cx = Math.max(0, (modalBox.x - pad));
    const cy = Math.max(0, (modalBox.y - pad));
    const cw = Math.min(modalImg._dw - cx, modalBox.w);
    const ch = Math.min(modalImg._dh - cy, modalBox.h);

    const finalCanvas = document.createElement('canvas');
    finalCanvas.width  = cw;
    finalCanvas.height = ch;
    finalCanvas.getContext('2d').drawImage(
      offscreenCanvas, cx, cy, cw, ch, 0, 0, cw, ch
    );

    const image_b64 = finalCanvas.toDataURL('image/png').split(',')[1];

    try {
      const res = await fetch('/save-trimmed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId, filename: modalFilename, image_b64 })
      });
      const data = await res.json();
      if (data.error) { showToast(data.error, 'fail'); return; }
      const savedFilename = modalFilename;
      const savedPageNum = modalOriginalCrop.page_num;
      closeCropModal();

      if (rect) {
        if (!savedCrops[savedPageNum]) savedCrops[savedPageNum] = [];
        savedCrops[savedPageNum].push({ x: rect.x, y: rect.y, w: rect.w, h: rect.h, filename: savedFilename });
        redrawPage(savedPageNum);
      }
      refreshCroppedList(savedFilename);
      rect = null; activePageNum = null;
      document.querySelectorAll('.pdf-page').forEach(p => p.classList.remove('active-crop'));
      selectedImage = images.find(n => !croppedSet.has(n)) || null;
      renderChips();
      showToast(`✓ Saved: ${savedFilename}`, 'pass');
    } catch(e) {
      showToast('Save failed: ' + e.message, 'fail');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Save Image';
    }
    return;
  }

  const pad = modalImg._pad || 0;
  const iw  = modalImg._dw;
  const ih  = modalImg._dh;
  const refineXPct = Math.max(0, (modalBox.x - pad)) / iw * 100;
  const refineYPct = Math.max(0, (modalBox.y - pad)) / ih * 100;
  const refineWPct = Math.min(modalBox.w, iw - Math.max(0, modalBox.x - pad)) / iw * 100;
  const refineHPct = Math.min(modalBox.h, ih - Math.max(0, modalBox.y - pad)) / ih * 100;

  const btn = document.getElementById('cropModalSave');
  btn.disabled = true;
  btn.textContent = 'Saving...';

  try {
    const res = await fetch('/crop-refine', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: sessionId,
        page_num: modalOriginalCrop.page_num,
        x: modalOriginalCrop.x, y: modalOriginalCrop.y, w: modalOriginalCrop.w, h: modalOriginalCrop.h,
        refine_x: refineXPct, refine_y: refineYPct, refine_w: refineWPct, refine_h: refineHPct,
        filename: modalFilename,
      })
    });
    const data = await res.json();
    if (data.error) { showToast(data.error, 'fail'); return; }

    const savedFilename = modalFilename;
    const savedPageNum = modalOriginalCrop.page_num;
    const savedCanvas = pagesContainer.querySelector(`canvas[data-page="${savedPageNum}"]`);
    closeCropModal();

    // Store overlay using original rect pixel coords
    if (rect && savedCanvas) {
      if (!savedCrops[savedPageNum]) savedCrops[savedPageNum] = [];
      savedCrops[savedPageNum].push({ x: rect.x, y: rect.y, w: rect.w, h: rect.h, filename: savedFilename });
    }

    refreshCroppedList(savedFilename);
    redrawPage(savedPageNum);
    document.querySelectorAll('.pdf-page').forEach(p => p.classList.remove('active-crop'));
    rect = null;
    activePageNum = null;

    selectedImage = images.find(n => !croppedSet.has(n)) || null;
    renderChips();

    showToast(`✓ Saved: ${savedFilename}`, 'pass');
    setTimeout(() => refreshXhtml(), 100);
  } catch (e) {
    showToast('Save failed: ' + e.message, 'fail');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save Image';
  }
};

document.addEventListener('keydown', e => {
  if (cropModal.style.display === 'none') return;
  if (e.key === 'Enter') document.getElementById('cropModalSave').click();
  else if (e.key === 'Escape') closeCropModal();
});

/* ══════════════════════════════════════════════════════════
   5. INIT
   ══════════════════════════════════════════════════════════ */
async function toggleXhtmlEdit() {
  const frame    = document.getElementById('xhtmlFrame');
  const editor   = document.getElementById('xhtmlEditor');
  const editBtn  = document.getElementById('editXhtmlBtn');
  const saveBtn  = document.getElementById('saveXhtmlBtn');
  const cancelBtn = document.getElementById('cancelXhtmlBtn');
  const refreshBtn = document.getElementById('refreshBtn');
  const title    = document.getElementById('previewTitle');

  // Fetch raw XHTML from backend
  try {
    const res  = await fetch('/get-xhtml', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId })
    });
    const data = await res.json();
    if (data.error) { showToast(data.error, 'fail'); return; }

    editor.value = data.content;
    frame.style.display  = 'none';
    editor.style.display = 'block';
    editBtn.style.display    = 'none';
    refreshBtn.style.display = 'none';
    saveBtn.style.display    = 'inline-flex';
    cancelBtn.style.display  = 'inline-flex';
    title.textContent = 'Edit XHTML';

    if (!cmEditor) {
      cmEditor = CodeMirror.fromTextArea(editor, {
        mode: 'xml',
        lineNumbers: true,
        lineWrapping: true,
        theme: html.dataset.theme === 'dark' ? 'midnight' : 'default',
        extraKeys: {
          "Ctrl-F": () => window._showCmSearch && window._showCmSearch(),
          "Escape": () => document.getElementById('cmSearchBar').style.display = 'none',
        }
      });
      initCmSearch();
    }
    cmEditor.setValue(data.content);
    cmEditor.refresh();
  } catch(e) {
    showToast('Failed to load XHTML: ' + e.message, 'fail');
  }
}

async function saveXhtmlEdit() {
  const editor  = document.getElementById('xhtmlEditor');
  const saveBtn = document.getElementById('saveXhtmlBtn');

  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving...';

  // Save iframe scroll position before edit
  let savedScrollY = 0, savedScrollX = 0;
  try {
    const iframeWin = document.getElementById('xhtmlFrame').contentWindow;
    savedScrollY = iframeWin.scrollY || 0;
    savedScrollX = iframeWin.scrollX || 0;
  } catch(e) {}

  try {
    const res  = await fetch('/save-xhtml', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, content: cmEditor.getValue() })
    });
    const data = await res.json();
    if (data.error) { showToast(data.error, 'fail'); return; }

    showToast('✓ XHTML saved', 'pass');
    cancelXhtmlEdit();
    setTimeout(() => {
      const frame = document.getElementById('xhtmlFrame');
      frame.addEventListener('load', function restoreScroll() {
        try { frame.contentWindow.scrollTo(savedScrollX, savedScrollY); } catch(e) {}
        frame.removeEventListener('load', restoreScroll);
      });
      refreshXhtml();
    }, 100);
  } catch(e) {
    showToast('Save failed: ' + e.message, 'fail');
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = '💾 Save';
  }
}

function initCmSearch() {
  const bar      = document.getElementById('cmSearchBar');
  const input    = document.getElementById('cmSearchInput');
  const countEl  = document.getElementById('cmSearchCount');
  const prevBtn  = document.getElementById('cmSearchPrev');
  const nextBtn  = document.getElementById('cmSearchNext');
  const closeBtn = document.getElementById('cmSearchClose');

  // Position bar relative to #preview-wrap
  function showBar() {
    const wrap = document.getElementById('preview-wrap');
    const rect = wrap.getBoundingClientRect();
    bar.style.display = 'flex';
    bar.style.top  = (rect.top + 6) + 'px';
    bar.style.right = (window.innerWidth - rect.right + 6) + 'px';
    bar.style.position = 'fixed';
    setTimeout(() => {
      input.focus();
      input.select();
    }, 50);
  }

  function hideBar() {
    bar.style.display = 'none';
    cmSearchMatches = [];
    cmSearchIndex   = -1;
    cmSearchQuery   = '';
    countEl.textContent = '';
    if (cmEditor) {
      cmEditor.getAllMarks().forEach(m => m.clear());
      cmEditor.focus();
    }
  }

  function doSearch(query) {
    if (!cmEditor || !query) return;
    cmEditor.getAllMarks().forEach(m => m.clear());
    cmSearchMatches = [];
    cmSearchIndex   = -1;
    cmSearchQuery   = query;

    const cursor = cmEditor.getSearchCursor(query, null, { caseFold: true });
    while (cursor.findNext()) {
      const from = cursor.from();
      const to   = cursor.to();
      cmSearchMatches.push({ from, to });
      cmEditor.markText(from, to, {
        className: 'cm-search-match',
        css: 'background:#FFEB3B;color:#000;border-radius:2px;'
      });
    }

    if (cmSearchMatches.length > 0) {
      jumpTo(0);
    } else {
      countEl.textContent = 'Not found';
      countEl.style.color = 'var(--fail)';
    }
  }

  function jumpTo(index) {
    if (!cmSearchMatches.length) return;
    cmSearchIndex = (index + cmSearchMatches.length) % cmSearchMatches.length;
    const match = cmSearchMatches[cmSearchIndex];

    // Highlight current
    cmEditor.getAllMarks().forEach(m => m.clear());
    cmSearchMatches.forEach((m, i) => {
      cmEditor.markText(m.from, m.to, {
        className: i === cmSearchIndex ? 'cm-search-active' : 'cm-search-match',
        css: i === cmSearchIndex
          ? 'background:#FF9800;color:#000;border-radius:2px;'
          : 'background:#FFEB3B;color:#000;border-radius:2px;'
      });
    });

    cmEditor.scrollIntoView({ from: match.from, to: match.to }, 100);
    cmEditor.setCursor(match.to);
    countEl.textContent = `${cmSearchIndex + 1}/${cmSearchMatches.length}`;
    countEl.style.color = 'var(--muted)';
  }

  // Input: search on type
  input.addEventListener('input', () => doSearch(input.value.trim()));

  // Enter = next, Shift+Enter = prev
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) jumpTo(cmSearchIndex - 1);
      else jumpTo(cmSearchIndex + 1);
    }
    if (e.key === 'Escape') hideBar();
  });

  prevBtn.addEventListener('click', () => jumpTo(cmSearchIndex - 1));
  nextBtn.addEventListener('click', () => jumpTo(cmSearchIndex + 1));
  closeBtn.addEventListener('click', hideBar);

  // Expose showBar so Ctrl+F can call it
  window._showCmSearch = showBar;
}

function cancelXhtmlEdit() {
  document.getElementById('cmSearchBar').style.display = 'none';
  if (cmEditor) { cmEditor.getAllMarks().forEach(m => m.clear()); }
  const frame     = document.getElementById('xhtmlFrame');
  const editor    = document.getElementById('xhtmlEditor');
  const editBtn   = document.getElementById('editXhtmlBtn');
  const saveBtn   = document.getElementById('saveXhtmlBtn');
  const cancelBtn = document.getElementById('cancelXhtmlBtn');
  const refreshBtn = document.getElementById('refreshBtn');
  const title     = document.getElementById('previewTitle');

  if (cmEditor) { cmEditor.toTextArea(); cmEditor = null; }
  editor.style.display = 'none';
  frame.style.display  = 'block';
  editBtn.style.display    = 'inline-flex';
  refreshBtn.style.display = 'inline-flex';
  saveBtn.style.display    = 'none';
  cancelBtn.style.display  = 'none';
  title.textContent = 'XHTML Preview';
}

const chipTooltip = createTooltip();
uploadBtn.disabled = true;
pagesContainer.style.display = 'none';
loadConfig();
initSelectionEdit();

/* PDF zoom buttons */
document.getElementById('pdfZoomIn')   ?.addEventListener('click', () => setPdfZoom(+ZOOM_STEP));
document.getElementById('pdfZoomOut')  ?.addEventListener('click', () => setPdfZoom(-ZOOM_STEP));
document.getElementById('pdfZoomReset')?.addEventListener('click', () => { pdfZoom = 1; applyPdfZoom(); });

/* XHTML zoom buttons */
document.getElementById('xhtmlZoomIn')   ?.addEventListener('click', () => setXhtmlZoom(+ZOOM_STEP));
document.getElementById('xhtmlZoomOut')  ?.addEventListener('click', () => setXhtmlZoom(-ZOOM_STEP));
document.getElementById('xhtmlZoomReset')?.addEventListener('click', () => { xhtmlZoom = 1; applyXhtmlZoom(); });

/* Ctrl+Scroll — PDF panel */
document.getElementById('canvas-wrap').addEventListener('wheel', e => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  setPdfZoom(e.deltaY < 0 ? +ZOOM_STEP : -ZOOM_STEP);
}, { passive: false });

/* Ctrl+Scroll — XHTML panel */
document.getElementById('preview-wrap').addEventListener('wheel', e => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  setXhtmlZoom(e.deltaY < 0 ? +ZOOM_STEP : -ZOOM_STEP);
}, { passive: false });

/* Restore zoom on xhtml reload */
xhtmlFrame.addEventListener('load', () => {
  applyXhtmlZoom();
  applyXhtmlTagHighlights();
});

function applyXhtmlTagHighlights() {
  try {
    const iframeDoc = xhtmlFrame.contentDocument || xhtmlFrame.contentWindow.document;
    if (!iframeDoc) return;

    let style = iframeDoc.getElementById('vilpower-highlight');
    if (!style) {
      style = iframeDoc.createElement('style');
      style.id = 'vilpower-highlight';
      iframeDoc.head.appendChild(style);
    }

    const rules = [];
    if (document.getElementById('hlBold')?.checked)
      rules.push('b, strong { background: #FFEB3B !important; outline: 1px solid #e6d000 !important; }');
    if (document.getElementById('hlItalic')?.checked)
      rules.push('i, em { background: #7DE87D !important; outline: 1px solid #4db84d !important; }');
    if (document.getElementById('hlSup')?.checked)
      rules.push('sup { background: #66BFFF !important; outline: 1px solid #1a8fe0 !important; }');
    if (document.getElementById('hlSub')?.checked)
      rules.push('sub { background: #FF9933 !important; outline: 1px solid #cc6600 !important; }');

    style.textContent = rules.join('\n');
  } catch(e) {
    console.warn('highlight inject failed', e);
  }
}

['hlBold','hlItalic','hlSup','hlSub'].forEach(id => {
  document.getElementById(id)?.addEventListener('change', applyXhtmlTagHighlights);
});

document.getElementById('highlightTagBtn')?.addEventListener('click', (e) => {
  e.stopPropagation();
  const panel = document.getElementById('highlightTagPanel');
  if (panel.style.display === 'none' || panel.style.display === '') {
    const rect = e.currentTarget.getBoundingClientRect();
    panel.style.top  = (rect.bottom + 4) + 'px';
    panel.style.left = rect.left + 'px';
    panel.style.display = 'block';
  } else {
    panel.style.display = 'none';
  }
});

document.addEventListener('click', (e) => {
  const panel = document.getElementById('highlightTagPanel');
  const btn = document.getElementById('highlightTagBtn');
  if (panel && !panel.contains(e.target) && e.target !== btn) {
    panel.style.display = 'none';
  }
});


document.getElementById('highlightToggleBtn')?.addEventListener('click', () => {
  if (!hasHighlightedPdf || !sessionId) return;
  viewingHighlight = !viewingHighlight;

  const btn           = document.getElementById('highlightToggleBtn');
  const highlightFrame = document.getElementById('highlightFrame');

  btn.textContent          = viewingHighlight ? '🔆 Highlighted' : '📄 Original';
  btn.style.background     = viewingHighlight ? 'var(--warn-soft)' : 'var(--surface-2)';
  btn.style.borderColor    = viewingHighlight ? 'var(--warn)'      : 'var(--border)';
  btn.style.color          = viewingHighlight ? 'var(--warn)'      : 'var(--text-2)';

  if (viewingHighlight) {
    // Show highlighted PDF in iframe
    if (!highlightFrame.src || highlightFrame.src === window.location.href) {
      highlightFrame.src = `/highlight-pdf/${sessionId}`;
    }
    highlightFrame.style.display = 'block';
    pagesContainer.style.display = 'none';

    // Disable crop
    if (cropMode) toggleCropMode();
    document.getElementById('cropModeBtn').style.opacity      = '0.4';
    document.getElementById('cropModeBtn').style.pointerEvents = 'none';
    document.getElementById('searchBar').style.opacity        = '0.4';
    document.getElementById('searchBar').style.pointerEvents  = 'none';
  } else {
    // Restore original PDF canvas
    highlightFrame.style.display = 'none';
    pagesContainer.style.display = 'flex';

    document.getElementById('cropModeBtn').style.opacity      = '1';
    document.getElementById('cropModeBtn').style.pointerEvents = 'auto';
    document.getElementById('searchBar').style.opacity        = '1';
    document.getElementById('searchBar').style.pointerEvents  = 'auto';
  }
});
