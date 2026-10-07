/*
 * Declinator — déclinaison d'une photo en plusieurs formats autour d'un point de focus.
 * Tout le traitement se fait dans le navigateur : aucune image n'est envoyée ni conservée.
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Réglages
  // ---------------------------------------------------------------------------
  const PREVIEW_H = 150;          // hauteur des vignettes (px CSS)
  const PROXY_MAX = 1800;         // côté max de l'image de travail utilisée pour les aperçus
  const MAX_ZOOM = 5;             // zoom manuel max (x5)
  const INTER_FACTOR = 3;         // l'image intermédiaire fait au plus 3x la taille finale
  const INTER_MAX_AREA = 16e6;    // et au plus 16 millions de pixels (limite Safari)
  const UPSCALE_WARN = 1.02;      // alerte dès 2 % d'agrandissement
  const BLUR_BASE = 320;          // le fond flou est calculé sur une image de 320 px de côté max…
  const BLUR_STRENGTH = 0.045;    // …avec un flou de 4,5 % de sa taille
  const STREAK_SOFTEN = 2.2;      // flou 2,2x plus fort en travers des traînées
  const EDGE_BAND = 0.08;         // épaisseur de la bande de bord reprise dans le fond flou (8 % de l'image)

  // ---------------------------------------------------------------------------
  // Formats
  // ---------------------------------------------------------------------------
  const GROUPS = Array.isArray(window.DECLINATOR_FORMATS) ? window.DECLINATOR_FORMATS : [];
  const FORMATS = [];
  const seen = new Set();
  for (const g of GROUPS) {
    for (const f of (g.formats || [])) {
      const ok = f && f.id && !seen.has(f.id) && f.width > 0 && f.height > 0;
      if (!ok) { console.warn('[Declinator] Format ignoré (id manquant ou en double, ou dimensions invalides) :', f); continue; }
      seen.add(f.id);
      FORMATS.push({ id: String(f.id), name: String(f.name || f.id), width: Math.round(f.width), height: Math.round(f.height), group: g.name });
    }
  }
  const byId = (id) => FORMATS.find((f) => f.id === id);

  // ---------------------------------------------------------------------------
  // État
  // ---------------------------------------------------------------------------
  const state = {
    img: null, url: null, W: 0, H: 0, fileName: '',
    proxy: null, proxyScale: 1,
    focus: { x: 0.5, y: 0.5 },
    overrides: Object.create(null),       // id -> { cx, cy, zoom } (coordonnées normalisées)
    selected: new Set(FORMATS.map((f) => f.id)),
    mode: 'focus', adjustId: null, hoverId: null,   // mode : 'focus' | 'adjust' | 'pick'
    fit: new Set(),                                  // formats en « Conserver le ratio »
    fill: { type: 'blur', color: '#1d1e2c' },        // fond de remplissage : 'blur' | 'color'
    imgVersion: 0, avgColor: '#808080',
    format: 'jpeg', quality: 90,
    busy: false, loading: false
  };

  // ---------------------------------------------------------------------------
  // DOM
  // ---------------------------------------------------------------------------
  const $ = (s) => document.querySelector(s);
  const ui = {
    app: $('#app'), dropzone: $('#dropzone'), viewer: $('#viewer'), fileInput: $('#file-input'),
    btnPick: $('#btn-pick'), btnNew: $('#btn-new'), status: $('#stage-status'),
    tbFocus: $('#tb-focus'), tbAdjust: $('#tb-adjust'), btnCenter: $('#btn-center'),
    adjName: $('#adj-name'), adjDims: $('#adj-dims'), zoom: $('#zoom'), zoomOut: $('#zoom-out'),
    btnAuto: $('#btn-auto'), btnDone: $('#btn-done'),
    area: $('#canvas-area'), photo: $('#photo'), photoImg: $('#photo-img'), spot: $('#spot'),
    ghost: $('#frame-ghost'), ghostLabel: $('#ghost-label'), edit: $('#frame-edit'), focus: $('#focus-marker'),
    metaHint: $('#meta-hint'), metaName: $('#meta-name'), metaDims: $('#meta-dims'),
    groups: $('#groups'), sheetIntro: $('#sheet-intro'),
    basename: $('#basename'), quality: $('#quality'), qualityOut: $('#quality-out'), qualityField: $('#quality-field'),
    btnZip: $('#btn-zip'), toast: $('#toast'),
    tbPick: $('#tb-pick'), btnPickCancel: $('#btn-pick-cancel'),
    loupe: $('#loupe'), loupeCanvas: $('#loupe-canvas'), loupeHex: $('#loupe-hex'), loupeChip: $('#loupe-chip'),
    allCrop: $('#all-crop'), allFit: $('#all-fit'), fillColor: $('#fill-color'), fillHex: $('#fill-hex'),
    btnPipette: $('#btn-pipette')
  };

  function el(tag, attrs, children) {
    const n = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      if (k === 'class') n.className = attrs[k];
      else if (attrs[k] === true) n.setAttribute(k, '');
      else if (attrs[k] !== false && attrs[k] != null) n.setAttribute(k, attrs[k]);
    }
    if (children != null) [].concat(children).forEach((c) => n.append(c));
    return n;
  }

  // ---------------------------------------------------------------------------
  // Utilitaires
  // ---------------------------------------------------------------------------
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const NNBSP = ' ';
  const dims = (w, h) => `${w}${NNBSP}×${NNBSP}${h}`;
  const fmtNum = (n) => n.toLocaleString('fr-FR', { maximumFractionDigits: 1 });
  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

  function slugify(s) {
    return String(s || '')
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);
  }
  const stripExt = (name) => String(name || '').replace(/\.[a-z0-9]{1,5}$/i, '');

  function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    return c;
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob a échoué'))), type, quality);
    });
  }

  function saveBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  const scripts = {};
  function loadScript(src) {
    if (!scripts[src]) {
      scripts[src] = new Promise((resolve, reject) => {
        const s = el('script', { src });
        s.onload = resolve;
        s.onerror = () => { delete scripts[src]; reject(new Error('Script introuvable : ' + src)); };
        document.head.append(s);
      });
    }
    return scripts[src];
  }

  let toastTimer = 0;
  function toast(msg, kind) {
    ui.toast.textContent = msg;
    ui.toast.dataset.kind = kind || 'info';
    ui.toast.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => ui.toast.classList.remove('is-on'), kind === 'error' ? 7000 : 3800);
  }

  const toHex = (r, g, b) => '#' + [r, g, b].map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');

  // Flou « boîte » répété 3 fois (proche d'un flou gaussien), sur des pixels RGBA.
  function boxBlur(imageData, rx, ry, passes) {
    const { width: w, height: h, data } = imageData;
    const tmp = new Uint8ClampedArray(data.length);
    const pass = (src, dst, len, lines, step, lineStep, radius) => {
      const div = 2 * radius + 1;
      for (let l = 0; l < lines; l++) {
        const base = l * lineStep;
        for (let c = 0; c < 4; c++) {
          let sum = 0;
          for (let k = -radius; k <= radius; k++) sum += src[base + clamp(k, 0, len - 1) * step + c];
          for (let i = 0; i < len; i++) {
            dst[base + i * step + c] = sum / div;
            sum += src[base + Math.min(len - 1, i + radius + 1) * step + c] - src[base + Math.max(0, i - radius) * step + c];
          }
        }
      }
    };
    for (let p = 0; p < passes; p++) {
      pass(data, tmp, w, h, 4, w * 4, rx);   // horizontal
      pass(tmp, data, h, w, w * 4, 4, ry);   // vertical
    }
  }

  const prefs = {
    get(k, d) { try { const v = localStorage.getItem('declinator.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('declinator.' + k, JSON.stringify(v)); } catch (e) { /* stockage indisponible */ } }
  };

  // ---------------------------------------------------------------------------
  // Calcul du cadrage
  // ---------------------------------------------------------------------------
  // Plus grand cadre aux proportions du format qui tienne dans la photo.
  function baseSize(f) {
    const r = f.width / f.height;
    return (state.W / state.H > r)
      ? { w: state.H * r, h: state.H }
      : { w: state.W, h: state.W / r };
  }

  // Cadre final (en pixels de la photo source) : centré sur le point de focus,
  // ou sur le centre manuel, puis ramené dans l'image si on touche un bord.
  function cropFor(f) {
    const o = state.overrides[f.id];
    const b = baseSize(f);
    const zoom = o ? o.zoom : 1;
    const w = b.w / zoom;
    const h = b.h / zoom;
    const cx = (o ? o.cx : state.focus.x) * state.W;
    const cy = (o ? o.cy : state.focus.y) * state.H;
    const x = clamp(cx - w / 2, 0, state.W - w);
    const y = clamp(cy - h / 2, 0, state.H - h);
    return { x, y, w, h, upscale: f.width / w };
  }

  function ensureOverride(f) {
    if (!state.overrides[f.id]) {
      const c = cropFor(f);
      state.overrides[f.id] = { cx: (c.x + c.w / 2) / state.W, cy: (c.y + c.h / 2) / state.H, zoom: 1 };
    }
    return state.overrides[f.id];
  }

  function setOverrideCenter(f, px, py) {
    const o = ensureOverride(f);
    const b = baseSize(f);
    const w = b.w / o.zoom;
    const h = b.h / o.zoom;
    o.cx = clamp(px, w / 2, state.W - w / 2) / state.W;
    o.cy = clamp(py, h / 2, state.H - h / 2) / state.H;
    render();
  }

  function setZoom(f, z) {
    const o = ensureOverride(f);
    o.zoom = clamp(z, 1, MAX_ZOOM);
    setOverrideCenter(f, o.cx * state.W, o.cy * state.H);
    syncZoomUI();
  }

  function setFocus(p) {
    state.focus = { x: clamp(p.x, 0, 1), y: clamp(p.y, 0, 1) };
    render();
  }

  // ---------------------------------------------------------------------------
  // « Conserver le ratio » : image entière + fond de remplissage
  // ---------------------------------------------------------------------------
  const isFit = (f) => state.fit.has(f.id);

  // Emplacement de l'image entière dans un cadre outW x outH (centrée).
  function containRect(outW, outH, round) {
    const s = Math.min(outW / state.W, outH / state.H);
    let dw = state.W * s;
    let dh = state.H * s;
    if (round) { dw = clamp(Math.round(dw), 1, outW); dh = clamp(Math.round(dh), 1, outH); }
    const dx = round ? Math.floor((outW - dw) / 2) : (outW - dw) / 2;
    const dy = round ? Math.floor((outH - dh) / 2) : (outH - dh) / 2;
    return { dx, dy, dw, dh, scale: s };
  }

  // Fond flou : la bande de bord de l'image (EDGE_BAND) est étirée en miroir
  // dans le vide, de sorte que les couleurs se raccordent au bord, puis le tout
  // est fortement flouté. Seuls les bords sont repris : le sujet n'est pas dupliqué.
  function blurredBackground(w, h, r) {
    const k = Math.min(1, BLUR_BASE / Math.max(w, h));
    const sw = Math.max(4, Math.round(w * k));
    const sh = Math.max(4, Math.round(h * k));
    const kx = sw / w;
    const ky = sh / h;
    const dx = r.dx * kx;
    const dy = r.dy * ky;
    const dw = Math.max(1, r.dw * kx);
    const dh = Math.max(1, r.dh * ky);
    const c = makeCanvas(sw, sh);
    const x = c.getContext('2d', { willReadFrequently: true });
    x.fillStyle = state.avgColor;
    x.fillRect(0, 0, sw, sh);
    x.imageSmoothingEnabled = true;
    x.imageSmoothingQuality = 'high';
    const pr = state.proxy;
    const pw = pr.width;
    const ph = pr.height;
    const bw = Math.max(1, Math.round(pw * EDGE_BAND));
    const bh = Math.max(1, Math.round(ph * EDGE_BAND));
    const right = sw - (dx + dw);
    const bottom = sh - (dy + dh);
    // Bande source (sx, sy, sW, sH) étirée dans la zone (tx, ty, tW, tH), retournée pour que le bord touche l'image
    const stretch = (sx, sy, sW, sH, tx, ty, tW, tH, flipX, flipY) => {
      if (tW <= 0 || tH <= 0) return;
      x.setTransform(flipX ? -1 : 1, 0, 0, flipY ? -1 : 1, flipX ? tx + tW : tx, flipY ? ty + tH : ty);
      x.drawImage(pr, sx, sy, sW, sH, 0, 0, tW, tH);
      x.setTransform(1, 0, 0, 1, 0, 0);
    };
    stretch(0, 0, pw, bh, dx, 0, dw, dy + 1, false, true);                      // haut
    stretch(0, ph - bh, pw, bh, dx, dy + dh - 1, dw, bottom + 1, false, true);  // bas
    stretch(0, 0, bw, ph, 0, dy, dx + 1, dh, true, false);                      // gauche
    stretch(pw - bw, 0, bw, ph, dx + dw - 1, dy, right + 1, dh, true, false);   // droite
    x.drawImage(pr, dx, dy, dw, dh);
    // Deux flous mélangés : près de l'image, un flou léger qui se raccorde au bord ;
    // plus loin, un flou fort (surtout en travers de l'étirement) qui fond les traînées.
    const radius = Math.max(2, Math.round(Math.max(sw, sh) * BLUR_STRENGTH));
    const strong = Math.round(radius * STREAK_SOFTEN);
    const vertical = dy + bottom > dx + right;
    const far = x.getImageData(0, 0, sw, sh);
    const near = new ImageData(new Uint8ClampedArray(far.data), sw, sh);
    boxBlur(near, Math.max(1, Math.round(radius * 0.7)), Math.max(1, Math.round(radius * 0.7)), 3);
    boxBlur(far, vertical ? strong : radius, vertical ? radius : strong, 3);
    const fade = Math.max(2, (vertical ? Math.max(dy, bottom) : Math.max(dx, right)) * 0.55);
    const nd = near.data;
    const fd = far.data;
    for (let j = 0; j < sh; j++) {
      for (let i = 0; i < sw; i++) {
        const dist = vertical
          ? (j < dy ? dy - j : (j > dy + dh ? j - dy - dh : 0))
          : (i < dx ? dx - i : (i > dx + dw ? i - dx - dw : 0));
        const t = clamp(1 - dist / fade, 0, 1);
        const wgt = t * t * (3 - 2 * t);   // transition douce
        const o = (j * sw + i) * 4;
        for (let c = 0; c < 4; c++) fd[o + c] = fd[o + c] + (nd[o + c] - fd[o + c]) * wgt;
      }
    }
    x.putImageData(far, 0, 0);
    return c;
  }

  function paintBackground(ctx, w, h, r) {
    ctx.clearRect(0, 0, w, h);
    if (state.fill.type === 'color') {
      ctx.fillStyle = state.fill.color;
      ctx.fillRect(0, 0, w, h);
      return;
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(blurredBackground(w, h, r), 0, 0, w, h);
  }

  // Couleurs moyennes de l'image (globale et des bords), pour le fond.
  function measureColors() {
    const n = 24;
    const c = makeCanvas(n, n);
    const x = c.getContext('2d', { willReadFrequently: true });
    x.imageSmoothingEnabled = true;
    x.imageSmoothingQuality = 'high';
    x.drawImage(state.proxy, 0, 0, n, n);
    const d = x.getImageData(0, 0, n, n).data;
    const all = [0, 0, 0, 0];
    const edge = [0, 0, 0, 0];
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const o = (j * n + i) * 4;
        if (d[o + 3] < 8) continue;
        const acc = (i < 2 || j < 2 || i >= n - 2 || j >= n - 2) ? [all, edge] : [all];
        for (const a of acc) { a[0] += d[o]; a[1] += d[o + 1]; a[2] += d[o + 2]; a[3]++; }
      }
    }
    const hex = (a, d0) => (a[3] ? toHex(a[0] / a[3], a[1] / a[3], a[2] / a[3]) : d0);
    state.avgColor = hex(all, '#808080');
    return hex(edge, state.avgColor);
  }

  function setFill(type, color) {
    if (type) state.fill.type = type;
    if (color) state.fill.color = color.toLowerCase();
    prefs.set('fill', state.fill.type);
    renderFitPanel();
    render();
  }

  function setFit(ids, on) {
    for (const id of ids) { if (on) state.fit.add(id); else state.fit.delete(id); }
    if (state.mode === 'adjust' && state.fit.has(state.adjustId)) exitAdjust();
    renderFitPanel();
    render();
  }

  function renderFitPanel() {
    const n = FORMATS.filter(isFit).length;
    ui.allCrop.setAttribute('aria-pressed', String(n === 0));
    ui.allFit.setAttribute('aria-pressed', String(n === FORMATS.length && n > 0));
    for (const r of document.querySelectorAll('input[name="fill"]')) r.checked = r.value === state.fill.type;
    ui.fillColor.value = state.fill.color;
    ui.fillHex.textContent = state.fill.color.toUpperCase();
    ui.btnPipette.disabled = !state.img;
    ui.btnPipette.setAttribute('aria-pressed', String(state.mode === 'pick'));
    for (const f of FORMATS) tiles[f.id] && (tiles[f.id].fitInput.checked = isFit(f));
  }

  // ---------------------------------------------------------------------------
  // Planche des vignettes
  // ---------------------------------------------------------------------------
  const tiles = Object.create(null);

  function buildSheet() {
    ui.groups.textContent = '';
    for (const g of GROUPS) {
      const list = FORMATS.filter((f) => f.group === g.name);
      if (!list.length) continue;
      const wrap = el('div', { class: 'tiles' }, list.map(buildTile));
      const n = list.length;
      ui.groups.append(el('section', { class: 'group' }, [
        el('h3', { class: 'group-title' }, [g.name, el('span', { class: 'group-count' }, `${n} format${n > 1 ? 's' : ''}`)]),
        wrap
      ]));
    }
  }

  function buildTile(f) {
    const fw = Math.round(PREVIEW_H * f.width / f.height);
    const canvas = el('canvas');
    const badge = el('span', { class: 'tile-badge', hidden: true }, 'Cadrage manuel');
    const frame = el('button', { class: 'tile-frame', type: 'button', disabled: true, 'aria-label': `Ajuster le cadrage : ${f.name}` }, [canvas, badge]);
    frame.style.width = fw + 'px';
    frame.style.height = PREVIEW_H + 'px';

    const check = el('input', { type: 'checkbox', checked: state.selected.has(f.id) });
    const fitInput = el('input', { type: 'checkbox', role: 'switch', checked: isFit(f) });
    const warn = el('p', { class: 'tile-warn', hidden: true });
    const btnAdjust = el('button', { class: 'tile-btn', type: 'button' }, 'Ajuster');
    const btnSave = el('button', { class: 'tile-btn', type: 'button' }, 'Télécharger');

    const tile = el('article', { class: 'tile', 'data-id': f.id }, [
      frame,
      el('label', { class: 'tile-name' }, [check, el('span', null, f.name)]),
      el('div', { class: 'tile-dims' }, dims(f.width, f.height)),
      el('label', { class: 'tile-fit' }, [fitInput, el('span', { class: 'switch', 'aria-hidden': 'true' }), el('span', null, 'Conserver le ratio')]),
      warn,
      el('div', { class: 'tile-actions' }, [btnAdjust, btnSave])
    ]);
    tile.style.setProperty('--fw', fw + 'px');

    frame.addEventListener('click', () => { if (!isFit(f)) enterAdjust(f.id); });
    btnAdjust.addEventListener('click', () => enterAdjust(f.id));
    btnSave.addEventListener('click', () => exportOne(f));
    fitInput.addEventListener('change', () => setFit([f.id], fitInput.checked));
    check.addEventListener('change', () => {
      if (check.checked) state.selected.add(f.id); else state.selected.delete(f.id);
      prefs.set('off', FORMATS.filter((x) => !state.selected.has(x.id)).map((x) => x.id));
      render();
      updateZipButton();
    });
    const hoverOn = () => { state.hoverId = f.id; render(); };
    const hoverOff = () => { if (state.hoverId === f.id) { state.hoverId = null; render(); } };
    tile.addEventListener('pointerenter', hoverOn);
    tile.addEventListener('pointerleave', hoverOff);
    tile.addEventListener('focusin', hoverOn);
    tile.addEventListener('focusout', hoverOff);

    tiles[f.id] = { tile, frame, canvas, badge, warn, check, fitInput, btnAdjust, btnSave, fw, fitKey: null };
    return tile;
  }

  function drawPreview(f, t) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(t.fw * dpr);
    const h = Math.round(PREVIEW_H * dpr);
    const cv = t.canvas;
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; t.fitKey = null; }
    const ctx = cv.getContext('2d');
    if (isFit(f)) {
      // L'aperçu « ratio conservé » ne dépend pas du point de focus : on ne le recalcule que si besoin.
      const key = [state.imgVersion, state.fill.type, state.fill.color, w, h].join('|');
      if (t.fitKey === key) return;
      t.fitKey = key;
      const r = containRect(w, h, false);
      paintBackground(ctx, w, h, r);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(state.proxy, r.dx, r.dy, r.dw, r.dh);
      return;
    }
    t.fitKey = null;
    const c = cropFor(f);
    const s = state.proxyScale;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(state.proxy, c.x * s, c.y * s, c.w * s, c.h * s, 0, 0, w, h);
  }

  // ---------------------------------------------------------------------------
  // Affichage
  // ---------------------------------------------------------------------------
  let raf = 0;
  function render() {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; renderStage(); renderTiles(); });
  }

  function placeFrame(node, c) {
    node.style.left = (c.x / state.W * 100) + '%';
    node.style.top = (c.y / state.H * 100) + '%';
    node.style.width = (c.w / state.W * 100) + '%';
    node.style.height = (c.h / state.H * 100) + '%';
  }

  function renderStage() {
    if (!state.img) return;
    const adjust = state.mode === 'adjust';
    const fx = state.focus.x * 100 + '%';
    const fy = state.focus.y * 100 + '%';
    ui.focus.style.left = fx;
    ui.focus.style.top = fy;
    ui.spot.style.setProperty('--fx', fx);
    ui.spot.style.setProperty('--fy', fy);
    ui.focus.hidden = state.mode !== 'focus';

    if (adjust) {
      placeFrame(ui.edit, cropFor(byId(state.adjustId)));
      ui.edit.hidden = false;
    } else {
      ui.edit.hidden = true;
    }

    const ghost = state.mode === 'focus' && state.hoverId ? byId(state.hoverId) : null;
    if (ghost) {
      const fit = isFit(ghost);
      placeFrame(ui.ghost, fit ? { x: 0, y: 0, w: state.W, h: state.H } : cropFor(ghost));
      ui.ghostLabel.textContent = `${ghost.name} ${dims(ghost.width, ghost.height)}${fit ? ', image entière' : ''}`;
      ui.ghost.hidden = false;
    } else {
      ui.ghost.hidden = true;
    }
  }

  function renderTiles() {
    const ready = !!state.img;
    for (const f of FORMATS) {
      const t = tiles[f.id];
      const fit = isFit(f);
      t.frame.disabled = !ready;
      t.tile.classList.toggle('is-off', !state.selected.has(f.id));
      t.tile.classList.toggle('is-fit', fit);
      t.tile.classList.toggle('is-adjusting', state.mode === 'adjust' && state.adjustId === f.id);
      t.frame.setAttribute('aria-label', fit ? `Aperçu : ${f.name}, image entière` : `Ajuster le cadrage : ${f.name}`);
      t.badge.hidden = fit || !state.overrides[f.id];
      t.btnAdjust.hidden = fit;
      if (!ready) { t.warn.hidden = true; continue; }
      drawPreview(f, t);
      const upscale = fit ? containRect(f.width, f.height, false).scale : cropFor(f).upscale;
      if (upscale > UPSCALE_WARN) {
        t.warn.textContent = `Photo trop petite : agrandie ×${fmtNum(upscale)}, risque de flou.`;
        t.warn.hidden = false;
      } else {
        t.warn.hidden = true;
      }
    }
  }

  function layoutPhoto() {
    if (!state.img) return;
    const cs = getComputedStyle(ui.area);
    const aw = ui.area.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const ah = ui.area.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    if (aw <= 0 || ah <= 0) return;
    const s = Math.min(aw / state.W, ah / state.H);
    ui.photo.style.width = Math.floor(state.W * s) + 'px';
    ui.photo.style.height = Math.floor(state.H * s) + 'px';
  }

  function renderToolbar() {
    const adjust = state.mode === 'adjust';
    ui.tbFocus.hidden = state.mode !== 'focus';
    ui.tbAdjust.hidden = !adjust;
    ui.tbPick.hidden = state.mode !== 'pick';
    ui.app.dataset.mode = state.mode;
    if (state.mode !== 'pick') ui.loupe.hidden = true;
    ui.btnPipette.setAttribute('aria-pressed', String(state.mode === 'pick'));
    if (state.mode === 'pick') {
      ui.metaHint.textContent = '';
      ui.photo.setAttribute('aria-label', 'Pipette : cliquez sur la photo pour prélever une couleur. Échap pour annuler.');
      return;
    }
    if (adjust) {
      const f = byId(state.adjustId);
      ui.adjName.textContent = f.name;
      ui.adjDims.textContent = dims(f.width, f.height);
      ui.metaHint.textContent = 'Faites glisser le cadre pour le déplacer. Molette ou curseur pour zoomer. Échap pour terminer.';
      ui.photo.setAttribute('aria-label', `Cadrage manuel du format ${f.name}. Flèches du clavier pour déplacer le cadre, Échap pour terminer.`);
      syncZoomUI();
    } else {
      ui.metaHint.textContent = '';
      ui.photo.setAttribute('aria-label', 'Photo. Cliquez ou utilisez les flèches du clavier pour placer le point de focus.');
    }
  }

  function syncZoomUI() {
    if (state.mode !== 'adjust') return;
    const o = state.overrides[state.adjustId];
    const z = Math.round((o ? o.zoom : 1) * 100);
    ui.zoom.value = z;
    ui.zoomOut.textContent = `${z}${NNBSP}%`;
  }

  function updateZipButton() {
    const n = FORMATS.filter((f) => state.selected.has(f.id)).length;
    if (!state.busy) {
      ui.btnZip.textContent = n === 0 ? 'Aucun format coché'
        : n === 1 ? 'Télécharger 1 format (.zip)'
        : `Télécharger les ${n} formats (.zip)`;
    }
    ui.btnZip.disabled = !state.img || n === 0 || state.busy;
  }

  // ---------------------------------------------------------------------------
  // Modes
  // ---------------------------------------------------------------------------
  function enterAdjust(id) {
    if (!state.img || state.busy) return;
    state.mode = 'adjust';
    state.adjustId = id;
    state.hoverId = null;
    renderToolbar();
    render();
    ui.photo.focus({ preventScroll: true });
  }

  function exitAdjust() {
    state.mode = 'focus';
    state.adjustId = null;
    renderToolbar();
    render();
  }

  // ---------------------------------------------------------------------------
  // Pipette
  // ---------------------------------------------------------------------------
  const LOUPE_PX = 15;     // pixels de la photo visibles dans la loupe
  const LOUPE_SIZE = 112;  // taille de la loupe (px CSS)

  function enterPick() {
    if (!state.img || state.busy) return;
    if (state.mode === 'adjust') exitAdjust();
    state.mode = 'pick';
    state.hoverId = null;
    renderToolbar();
    render();
    ui.photo.focus({ preventScroll: true });
  }

  function exitPick() {
    if (state.mode !== 'pick') return;
    state.mode = 'focus';
    renderToolbar();
    render();
  }

  function sampleAt(p) {
    const pr = state.proxy;
    const px = clamp(Math.floor(p.x * pr.width), 0, pr.width - 1);
    const py = clamp(Math.floor(p.y * pr.height), 0, pr.height - 1);
    const x0 = clamp(px - 1, 0, pr.width - 1), y0 = clamp(py - 1, 0, pr.height - 1);
    const x1 = clamp(px + 1, 0, pr.width - 1), y1 = clamp(py + 1, 0, pr.height - 1);
    const d = pr.getContext('2d').getImageData(x0, y0, x1 - x0 + 1, y1 - y0 + 1).data;
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
    return toHex(r / n, g / n, b / n);
  }

  function updateLoupe(e) {
    const p = pointerToNorm(e);
    const pr = state.proxy;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const size = Math.round(LOUPE_SIZE * dpr);
    const cv = ui.loupeCanvas;
    if (cv.width !== size) { cv.width = size; cv.height = size; }
    const ctx = cv.getContext('2d');
    const cx = Math.floor(p.x * pr.width);
    const cy = Math.floor(p.y * pr.height);
    const half = Math.floor(LOUPE_PX / 2);
    const cell = size / LOUPE_PX;
    ctx.fillStyle = '#16161c';
    ctx.fillRect(0, 0, size, size);
    ctx.imageSmoothingEnabled = false;
    const sx = cx - half, sy = cy - half;
    const vx0 = Math.max(0, sx), vy0 = Math.max(0, sy);
    const vx1 = Math.min(pr.width, sx + LOUPE_PX), vy1 = Math.min(pr.height, sy + LOUPE_PX);
    if (vx1 > vx0 && vy1 > vy0) {
      ctx.drawImage(pr, vx0, vy0, vx1 - vx0, vy1 - vy0, (vx0 - sx) * cell, (vy0 - sy) * cell, (vx1 - vx0) * cell, (vy1 - vy0) * cell);
    }
    ctx.lineWidth = Math.max(1.5, dpr * 1.5);
    ctx.strokeStyle = '#fff';
    ctx.strokeRect(half * cell, half * cell, cell, cell);
    ctx.strokeStyle = 'rgba(0,0,0,.6)';
    ctx.strokeRect(half * cell - ctx.lineWidth, half * cell - ctx.lineWidth, cell + 2 * ctx.lineWidth, cell + 2 * ctx.lineWidth);

    const hex = sampleAt(p);
    ui.loupeHex.textContent = hex.toUpperCase();
    ui.loupeChip.style.background = hex;

    const area = ui.area.getBoundingClientRect();
    let lx = e.clientX - area.left + 22;
    let ly = e.clientY - area.top + 22;
    if (lx + LOUPE_SIZE > area.width - 4) lx = e.clientX - area.left - 22 - LOUPE_SIZE;
    if (ly + LOUPE_SIZE + 30 > area.height - 4) ly = e.clientY - area.top - 22 - LOUPE_SIZE - 30;
    ui.loupe.style.left = lx + 'px';
    ui.loupe.style.top = ly + 'px';
    ui.loupe.hidden = false;
  }

  // ---------------------------------------------------------------------------
  // Ouverture de la photo
  // ---------------------------------------------------------------------------
  function decodeBlob(blob) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => {
        if (!img.naturalWidth || !img.naturalHeight) { URL.revokeObjectURL(url); reject(new Error('Image vide')); return; }
        const ready = img.decode ? img.decode().catch(() => {}) : Promise.resolve();
        ready.then(() => resolve({ img, url }));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image illisible')); };
      img.src = url;
    });
  }

  async function looksLikeHeif(file) {
    if (/hei[cf]/i.test(file.type) || /\.(heic|heif)$/i.test(file.name || '')) return true;
    try {
      const b = new Uint8Array(await file.slice(0, 16).arrayBuffer());
      const box = String.fromCharCode(...b.slice(4, 8));
      const brand = String.fromCharCode(...b.slice(8, 12));
      return box === 'ftyp' && /^(heic|heix|hevc|hevx|heim|heis|hevm|hevs|mif1|msf1)$/.test(brand);
    } catch (e) { return false; }
  }

  async function decodeAny(file) {
    try {
      return await decodeBlob(file); // Safari lit le HEIC nativement
    } catch (err) {
      if (!(await looksLikeHeif(file))) throw err;
      showStatus('Conversion de la photo HEIC…');
      await loadScript('vendor/heic2any.min.js');
      const out = await window.heic2any({ blob: file, toType: 'image/jpeg', quality: 0.96 });
      return decodeBlob(Array.isArray(out) ? out[0] : out);
    }
  }

  function showStatus(text) {
    ui.status.textContent = text;
    ui.status.hidden = !text;
  }

  function buildProxy() {
    const s = Math.min(1, PROXY_MAX / Math.max(state.W, state.H));
    const c = makeCanvas(state.W * s, state.H * s);
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(state.img, 0, 0, c.width, c.height);
    state.proxy = c;
    state.proxyScale = c.width / state.W;
  }

  async function loadFile(file) {
    if (!file || state.busy || state.loading) return;
    state.loading = true;
    showStatus('Ouverture de la photo…');
    try {
      const { img, url } = await decodeAny(file);
      if (state.url) URL.revokeObjectURL(state.url);
      state.img = img;
      state.url = url;
      state.W = img.naturalWidth;
      state.H = img.naturalHeight;
      state.fileName = file.name || 'image';
      state.focus = { x: 0.5, y: 0.5 };
      state.overrides = Object.create(null);
      state.hoverId = null;
      state.imgVersion++;
      buildProxy();
      // Couleur de fond proposée : la couleur moyenne des bords de la photo
      state.fill.color = measureColors();

      ui.photoImg.src = url;
      ui.basename.value = slugify(stripExt(state.fileName)) || 'visuel';
      ui.metaName.textContent = state.fileName;
      ui.metaDims.textContent = `${dims(state.W, state.H)} px`;
      ui.app.dataset.state = 'ready';
      ui.dropzone.hidden = true;
      ui.viewer.hidden = false;
      ui.btnNew.hidden = false;
      ui.sheetIntro.textContent = 'Cliquez sur une vignette pour ajuster son cadrage à la main. Décochez les formats dont vous n\'avez pas besoin.';

      state.mode = 'focus';
      exitAdjust();
      renderFitPanel();
      layoutPhoto();
      render();
      updateZipButton();
    } catch (err) {
      console.error(err);
      toast('Impossible d\'ouvrir ce fichier. Utilisez une photo JPG, PNG, WebP ou HEIC.', 'error');
    } finally {
      state.loading = false;
      showStatus('');
      ui.fileInput.value = '';
    }
  }

  // ---------------------------------------------------------------------------
  // Export haute qualité
  // ---------------------------------------------------------------------------
  let picaInstance = null;

  function stepResize(from, to) {
    let src = from;
    let w = from.width;
    let h = from.height;
    while (w / 2 >= to.width && h / 2 >= to.height) {
      w = Math.round(w / 2);
      h = Math.round(h / 2);
      const c = makeCanvas(w, h);
      const x = c.getContext('2d');
      x.imageSmoothingEnabled = true;
      x.imageSmoothingQuality = 'high';
      x.drawImage(src, 0, 0, w, h);
      src = c;
    }
    const ctx = to.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, to.width, to.height);
  }

  async function resizeHQ(from, to) {
    if (window.pica) {
      try {
        picaInstance = picaInstance || window.pica({ features: ['js', 'wasm', 'ww'] });
        const down = to.width < from.width;
        await picaInstance.resize(from, to, down
          ? { filter: 'lanczos3', unsharpAmount: 55, unsharpRadius: 0.6, unsharpThreshold: 2 }
          : { filter: 'lanczos3' });
        return;
      } catch (err) {
        console.warn('[Declinator] Redimensionnement avancé indisponible, repli sur le navigateur.', err);
        picaInstance = null;
      }
    }
    stepResize(from, to);
  }

  // Une zone de la photo d'origine, rendue en haute qualité à la taille tw x th.
  async function renderRegion(c, tw, th) {
    // 1. Découpe de la zone, ramenée au plus à ~3x la taille finale
    const factor = Math.max(1, Math.min(INTER_FACTOR, Math.sqrt(INTER_MAX_AREA / (tw * th))));
    let iw = Math.max(1, Math.round(c.w));
    let ih = Math.max(1, Math.round(c.h));
    if (iw > tw * factor) { iw = Math.round(tw * factor); ih = Math.round(th * factor); }
    const inter = makeCanvas(iw, ih);
    const ictx = inter.getContext('2d');
    ictx.imageSmoothingEnabled = true;
    ictx.imageSmoothingQuality = 'high';
    ictx.drawImage(state.img, c.x, c.y, c.w, c.h, 0, 0, inter.width, inter.height);
    if (inter.width === tw && inter.height === th) return inter;

    // 2. Redimensionnement final (Lanczos)
    const out = makeCanvas(tw, th);
    await resizeHQ(inter, out);
    inter.width = inter.height = 0;
    return out;
  }

  // « Conserver le ratio » : fond (flou ou couleur) + image entière centrée.
  async function renderFit(f) {
    const tw = f.width;
    const th = f.height;
    const r = containRect(tw, th, true);
    const out = makeCanvas(tw, th);
    const ctx = out.getContext('2d');
    paintBackground(ctx, tw, th, r);
    const fg = await renderRegion({ x: 0, y: 0, w: state.W, h: state.H }, r.dw, r.dh);
    ctx.drawImage(fg, r.dx, r.dy);
    return out;
  }

  async function renderOutput(f) {
    const tw = f.width;
    const th = f.height;
    let out = isFit(f) ? await renderFit(f) : await renderRegion(cropFor(f), tw, th);

    // Encodage (fond blanc pour le JPG : pas de transparence)
    const png = state.format === 'png';
    if (!png) {
      const flat = makeCanvas(tw, th);
      const fctx = flat.getContext('2d');
      fctx.fillStyle = '#ffffff';
      fctx.fillRect(0, 0, tw, th);
      fctx.drawImage(out, 0, 0);
      out = flat;
    }
    return canvasToBlob(out, png ? 'image/png' : 'image/jpeg', state.quality / 100);
  }

  const currentBase = () => slugify(ui.basename.value) || 'visuel';
  const fileNameFor = (f, base) => `${base}_${f.id}_${f.width}x${f.height}.${state.format === 'png' ? 'png' : 'jpg'}`;

  function setBusy(on) {
    state.busy = on;
    ui.app.classList.toggle('is-busy', on);
    for (const id in tiles) tiles[id].btnSave.disabled = on;
    ui.btnNew.disabled = on;
    updateZipButton();
  }

  async function exportZip() {
    const list = FORMATS.filter((f) => state.selected.has(f.id));
    if (!state.img || !list.length || state.busy) return;
    if (state.mode !== 'focus') exitAdjust();
    setBusy(true);
    const base = currentBase();
    try {
      const zip = new window.JSZip();
      for (let i = 0; i < list.length; i++) {
        ui.btnZip.textContent = `Préparation ${i + 1}/${list.length}…`;
        await nextFrame();
        zip.file(fileNameFor(list[i], base), await renderOutput(list[i]));
      }
      ui.btnZip.textContent = 'Création du .zip…';
      await nextFrame();
      const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
      const name = `${base}_declinaisons.zip`;
      saveBlob(blob, name);
      toast(list.length === 1 ? `1 format téléchargé dans ${name}` : `${list.length} formats téléchargés dans ${name}`);
    } catch (err) {
      console.error(err);
      toast('Le téléchargement a échoué. Réessayez ; si le problème persiste, essayez avec une photo plus légère.', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function exportOne(f) {
    if (!state.img || state.busy) return;
    setBusy(true);
    try {
      await nextFrame();
      const name = fileNameFor(f, currentBase());
      saveBlob(await renderOutput(f), name);
      toast(`${f.name} téléchargé (${name})`);
    } catch (err) {
      console.error(err);
      toast(`Le téléchargement du format ${f.name} a échoué. Réessayez.`, 'error');
    } finally {
      setBusy(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Interactions sur la photo
  // ---------------------------------------------------------------------------
  let drag = null;
  let placingTimer = 0;

  function pointerToNorm(e) {
    const r = ui.photo.getBoundingClientRect();
    return { x: clamp((e.clientX - r.left) / r.width, 0, 1), y: clamp((e.clientY - r.top) / r.height, 0, 1) };
  }

  ui.photo.addEventListener('pointerdown', (e) => {
    if (!state.img || e.button > 0) return;
    e.preventDefault();
    ui.photo.focus({ preventScroll: true });
    const p = pointerToNorm(e);
    if (state.mode === 'pick') {
      const hex = sampleAt(p);
      exitPick();
      setFill('color', hex);
      toast(`Couleur de fond prélevée : ${hex.toUpperCase()}`);
      return;
    }
    ui.photo.setPointerCapture(e.pointerId);
    if (state.mode === 'focus') {
      drag = { type: 'focus' };
      clearTimeout(placingTimer);
      ui.photo.classList.add('is-placing');
      setFocus(p);
    } else {
      const f = byId(state.adjustId);
      const c = cropFor(f);
      const px = p.x * state.W;
      const py = p.y * state.H;
      const inside = px >= c.x && px <= c.x + c.w && py >= c.y && py <= c.y + c.h;
      if (inside) {
        drag = { type: 'frame', dx: c.x + c.w / 2 - px, dy: c.y + c.h / 2 - py };
      } else {
        drag = { type: 'frame', dx: 0, dy: 0 };
        setOverrideCenter(f, px, py);
      }
    }
  });

  ui.photo.addEventListener('pointermove', (e) => {
    if (state.mode === 'pick' && state.img) { updateLoupe(e); return; }
    if (!drag) return;
    const p = pointerToNorm(e);
    if (drag.type === 'focus') setFocus(p);
    else setOverrideCenter(byId(state.adjustId), p.x * state.W + drag.dx, p.y * state.H + drag.dy);
  });

  function endDrag() {
    if (!drag) return;
    if (drag.type === 'focus') {
      clearTimeout(placingTimer);
      placingTimer = setTimeout(() => ui.photo.classList.remove('is-placing'), 450);
    }
    drag = null;
  }
  ui.photo.addEventListener('pointerup', endDrag);
  ui.photo.addEventListener('pointercancel', endDrag);
  ui.photo.addEventListener('lostpointercapture', endDrag);
  ui.photo.addEventListener('pointerleave', () => { ui.loupe.hidden = true; });

  ui.photo.addEventListener('wheel', (e) => {
    if (state.mode !== 'adjust') return;
    e.preventDefault();
    const f = byId(state.adjustId);
    const o = ensureOverride(f);
    setZoom(f, o.zoom * Math.exp(-e.deltaY * 0.0015));
  }, { passive: false });

  ui.photo.addEventListener('keydown', (e) => {
    if (!state.img) return;
    const step = e.shiftKey ? 0.05 : 0.01;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (!d || state.mode === 'pick') return;
    e.preventDefault();
    if (state.mode === 'focus') {
      setFocus({ x: state.focus.x + d[0], y: state.focus.y + d[1] });
    } else {
      const f = byId(state.adjustId);
      const o = ensureOverride(f);
      setOverrideCenter(f, (o.cx + d[0]) * state.W, (o.cy + d[1]) * state.H);
    }
  });

  // ---------------------------------------------------------------------------
  // Barre d'outils, export, fichiers
  // ---------------------------------------------------------------------------
  ui.btnCenter.addEventListener('click', () => setFocus({ x: 0.5, y: 0.5 }));
  ui.btnDone.addEventListener('click', exitAdjust);
  ui.btnAuto.addEventListener('click', () => {
    delete state.overrides[state.adjustId];
    syncZoomUI();
    render();
  });
  ui.zoom.addEventListener('input', () => setZoom(byId(state.adjustId), ui.zoom.value / 100));

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (state.mode === 'adjust') { e.preventDefault(); exitAdjust(); ui.photo.focus({ preventScroll: true }); }
    else if (state.mode === 'pick') { e.preventDefault(); exitPick(); }
  });

  // Conserver le ratio et fond de remplissage
  ui.allCrop.addEventListener('click', () => setFit(FORMATS.map((f) => f.id), false));
  ui.allFit.addEventListener('click', () => setFit(FORMATS.map((f) => f.id), true));
  for (const r of document.querySelectorAll('input[name="fill"]')) {
    r.addEventListener('change', () => { if (r.checked) setFill(r.value); });
  }
  ui.fillColor.addEventListener('input', () => setFill('color', ui.fillColor.value));
  ui.btnPipette.addEventListener('click', () => (state.mode === 'pick' ? exitPick() : enterPick()));
  ui.btnPickCancel.addEventListener('click', exitPick);

  ui.btnPick.addEventListener('click', () => ui.fileInput.click());
  ui.btnNew.addEventListener('click', () => ui.fileInput.click());
  ui.fileInput.addEventListener('change', () => loadFile(ui.fileInput.files && ui.fileInput.files[0]));
  ui.btnZip.addEventListener('click', exportZip);

  for (const r of document.querySelectorAll('input[name="fmt"]')) {
    r.addEventListener('change', () => {
      if (!r.checked) return;
      state.format = r.value;
      prefs.set('format', state.format);
      ui.qualityField.classList.toggle('is-disabled', state.format === 'png');
      ui.quality.disabled = state.format === 'png';
    });
  }
  ui.quality.addEventListener('input', () => {
    state.quality = Number(ui.quality.value);
    ui.qualityOut.textContent = ui.quality.value;
    prefs.set('quality', state.quality);
  });
  ui.basename.addEventListener('blur', () => { ui.basename.value = currentBase(); });

  // Glisser-déposer n'importe où dans la fenêtre
  let dragDepth = 0;
  const hasFiles = (e) => !!e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    ui.app.classList.add('is-dragging');
  });
  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) ui.app.classList.remove('is-dragging');
  });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    ui.app.classList.remove('is-dragging');
    const files = Array.from(e.dataTransfer.files || []);
    loadFile(files.find((f) => /^image\//.test(f.type) || /\.(heic|heif)$/i.test(f.name)) || files[0]);
  });

  // Coller une image (⌘V / Ctrl+V)
  window.addEventListener('paste', (e) => {
    const items = e.clipboardData ? Array.from(e.clipboardData.items) : [];
    const item = items.find((i) => i.kind === 'file' && /^image\//.test(i.type));
    if (!item) return;
    e.preventDefault();
    const blob = item.getAsFile();
    if (!blob) return;
    const ext = (blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
    loadFile(new File([blob], blob.name && blob.name !== 'image.png' ? blob.name : `image-collee.${ext}`, { type: blob.type }));
  });

  if (window.ResizeObserver) new ResizeObserver(() => { layoutPhoto(); render(); }).observe(ui.area);
  else window.addEventListener('resize', () => { layoutPhoto(); render(); });

  // ---------------------------------------------------------------------------
  // Démarrage
  // ---------------------------------------------------------------------------
  (function init() {
    for (const id of prefs.get('off', [])) state.selected.delete(id);
    const fmt = prefs.get('format', 'jpeg');
    state.format = fmt === 'png' ? 'png' : 'jpeg';
    const q = Number(prefs.get('quality', 90));
    state.quality = clamp(Number.isFinite(q) ? q : 90, 60, 100);
    ui.quality.value = state.quality;
    ui.qualityOut.textContent = state.quality;
    const radio = document.querySelector(`input[name="fmt"][value="${state.format}"]`);
    if (radio) radio.checked = true;
    ui.qualityField.classList.toggle('is-disabled', state.format === 'png');
    ui.quality.disabled = state.format === 'png';
    state.fill.type = prefs.get('fill', 'blur') === 'color' ? 'color' : 'blur';

    if (!FORMATS.length) {
      ui.sheetIntro.textContent = 'Aucun format défini. Ajoutez des formats dans le fichier js/formats.js.';
    }
    buildSheet();
    renderFitPanel();
    renderTiles();
    updateZipButton();

    // Accès pour les tests automatisés
    window.Declinator = { state, cropFor, containRect, FORMATS, loadFile };
  })();
})();
