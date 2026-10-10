/*
 * Declinator — déclinaison d'une photo en plusieurs formats autour d'un point de focus.
 * Tout le traitement se fait dans le navigateur : aucune image n'est envoyée ni conservée.
 *
 * Zone centrale, trois modes :
 *   - « focus »  : tous les formats ; un clic sur la photo place le point de focus commun ;
 *   - « format » : un format sélectionné dans la liste ; on déplace / zoome son cadre ;
 *   - « pick »   : pipette pour prélever la couleur de fond.
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Réglages
  // ---------------------------------------------------------------------------
  const PROXY_MAX = 1800;         // côté max de l'image de travail utilisée pour les aperçus
  const MAX_ZOOM = 5;             // zoom manuel max (x5)
  const INTER_FACTOR = 3;         // l'image intermédiaire fait au plus 3x la taille finale
  const INTER_MAX_AREA = 16e6;    // et au plus 16 millions de pixels (limite Safari)
  const UPSCALE_WARN = 1.02;      // alerte dès 2 % d'agrandissement
  const BLUR_BASE = 320;          // le fond flou est calculé sur une image de 320 px de côté max…
  const BLUR_STRENGTH = 0.045;    // …avec un flou de 4,5 % de sa taille
  const STREAK_SOFTEN = 2.2;      // flou 2,2x plus fort en travers des traînées
  const EDGE_BAND = 0.08;         // épaisseur de la bande de bord reprise dans le fond flou (8 % de l'image)
  const HANDLE_HIT = 14;          // zone de prise des poignées du cadre (px écran)

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
    selected: new Set(FORMATS.map((f) => f.id)),   // formats cochés pour l'export
    mode: 'focus', currentId: null, hoverId: null, // mode : 'focus' | 'format' | 'pick'
    pickReturn: null,
    fit: new Set(),                                  // formats en « Conserver le ratio »
    fill: { type: 'blur', color: '#301739', length: 0.6 },  // fond : 'blur' | 'color' | 'gradient'
    imgVersion: 0, avgColor: '#808080',
    format: 'jpeg', quality: 90,
    busy: false, loading: false
  };

  // ---------------------------------------------------------------------------
  // DOM
  // ---------------------------------------------------------------------------
  const $ = (s) => document.querySelector(s);
  const ui = {
    app: $('#app'), dropzone: $('#dropzone'), viewer: $('#viewer'), fileInput: $('#file-input'), status: $('#stage-status'),
    btnPick: $('#btn-pick'), btnNew: $('#btn-new'), btnRemove: $('#btn-remove'),
    fileThumb: $('#file-thumb'), metaName: $('#meta-name'), metaDims: $('#meta-dims'),
    vhName: $('#vh-name'), vhDims: $('#vh-dims'), vhTag: $('#vh-tag'),
    btnCenter: $('#btn-center'), btnAuto: $('#btn-auto'), btnAll: $('#btn-all'), btnPickCancel: $('#btn-pick-cancel'),
    area: $('#canvas-area'), photo: $('#photo'), photoImg: $('#photo-img'), spot: $('#spot'),
    ghost: $('#frame-ghost'), ghostLabel: $('#ghost-label'), edit: $('#frame-edit'), focus: $('#focus-marker'),
    fitPreview: $('#fit-preview'),
    loupe: $('#loupe'), loupeCanvas: $('#loupe-canvas'), loupeHex: $('#loupe-hex'), loupeChip: $('#loupe-chip'),
    hint: $('#hint'), btnPrev: $('#btn-prev'), btnNext: $('#btn-next'), navCount: $('#nav-count'),
    count: $('#count'), sideIntro: $('#side-intro'), groups: $('#groups'),
    allCrop: $('#all-crop'), allFit: $('#all-fit'),
    fillSeg: $('#fill-seg'), fillCount: $('#fill-count'), fillNote: $('#fill-note'),
    fillExtra: $('#fill-extra'), colorRow: $('#color-row'), fillColor: $('#fill-color'), fillHex: $('#fill-hex'), btnPipette: $('#btn-pipette'),
    gradientRow: $('#gradient-row'), fillLength: $('#fill-length'), fillLengthOut: $('#fill-length-out'),
    basename: $('#basename'), quality: $('#quality'), qualityOut: $('#quality-out'), qualityField: $('#quality-field'),
    btnZip: $('#btn-zip'), zipLabel: $('#zip-label'), exportHint: $('#export-hint'),
    toast: $('#toast')
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

  function svgIcon(paths, size) {
    const s = size || 16;
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('width', s); svg.setAttribute('height', s); svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.5');
    svg.setAttribute('stroke-linecap', 'square'); svg.setAttribute('aria-hidden', 'true');
    for (const d of paths) { const p = document.createElementNS(NS, 'path'); p.setAttribute('d', d); svg.append(p); }
    return svg;
  }

  // ---------------------------------------------------------------------------
  // Utilitaires
  // ---------------------------------------------------------------------------
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const NNBSP = ' ';
  const dims = (w, h) => `${w}${NNBSP}×${NNBSP}${h}`;
  const fmtNum = (n) => n.toLocaleString('fr-FR', { maximumFractionDigits: 1 });
  const plural = (n, word) => `${n} ${word}${n > 1 ? 's' : ''}`;
  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  const dpr = () => Math.min(window.devicePixelRatio || 1, 2);

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

  const hexToRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const toHex = (r, g, b) => '#' + [r, g, b].map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');

  // Flou « boîte » répété (proche d'un flou gaussien), sur des pixels RGBA.
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
  }

  function resetOverride(f) {
    if (!state.overrides[f.id]) return;
    delete state.overrides[f.id];
    render();
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

  // Fond flou : la bande de bord de l'image (EDGE_BAND) est étirée en miroir dans
  // le vide, de sorte que les couleurs se raccordent au bord, puis fortement floutée.
  // En « Dégradé », on glisse ensuite progressivement vers la couleur choisie.
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
    // Deux flous mélangés : léger près de l'image (raccord), fort plus loin (fond les traînées).
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
    const toColor = state.fill.type === 'gradient';
    const col = toColor ? hexToRgb(state.fill.color) : null;
    for (let j = 0; j < sh; j++) {
      for (let i = 0; i < sw; i++) {
        let dist, pad;
        if (vertical) {
          dist = j < dy ? dy - j : (j > dy + dh ? j - dy - dh : 0);
          pad = j < dy + dh / 2 ? dy : bottom;
        } else {
          dist = i < dx ? dx - i : (i > dx + dw ? i - dx - dw : 0);
          pad = i < dx + dw / 2 ? dx : right;
        }
        const t = clamp(1 - dist / fade, 0, 1);
        const wgt = t * t * (3 - 2 * t);
        const o = (j * sw + i) * 4;
        for (let c2 = 0; c2 < 4; c2++) fd[o + c2] = fd[o + c2] + (nd[o + c2] - fd[o + c2]) * wgt;
        if (toColor && dist > 0) {
          const u = clamp(dist / Math.max(1, pad * state.fill.length), 0, 1);
          const wc = u * u * (3 - 2 * u);
          for (let c2 = 0; c2 < 3; c2++) fd[o + c2] = fd[o + c2] + (col[c2] - fd[o + c2]) * wc;
          fd[o + 3] = 255;
        }
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

  // Aperçu d'un format en ratio conservé, dessiné dans un canvas w x h (pixels).
  function drawFitComposition(ctx, w, h) {
    const r = containRect(w, h, false);
    paintBackground(ctx, w, h, r);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(state.proxy, r.dx, r.dy, r.dw, r.dh);
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

  // Choisir une couleur passe en mode Couleur, sauf si l'on est déjà en Dégradé.
  const colorMode = () => (state.fill.type === 'blur' ? 'color' : null);

  function setFill(type, color, length) {
    if (type) state.fill.type = type;
    if (color) state.fill.color = color.toLowerCase();
    if (length) state.fill.length = clamp(length, 0.2, 1);
    prefs.set('fill', state.fill.type);
    prefs.set('fillLength', state.fill.length);
    renderSettings();
    render();
  }

  function setFit(ids, on) {
    for (const id of ids) { if (on) state.fit.add(id); else state.fit.delete(id); }
    renderSettings();
    render();
  }

  // ---------------------------------------------------------------------------
  // Réglages communs
  // ---------------------------------------------------------------------------
  function renderSettings() {
    const nFit = FORMATS.filter(isFit).length;
    ui.allCrop.setAttribute('aria-pressed', String(nFit === 0));
    ui.allFit.setAttribute('aria-pressed', String(nFit === FORMATS.length && nFit > 0));

    const active = nFit > 0;
    ui.fillSeg.classList.toggle('is-off', !active);
    for (const r of ui.fillSeg.querySelectorAll('input')) {
      r.checked = r.value === state.fill.type;
      r.disabled = !active;
    }
    ui.fillCount.textContent = active ? `· ${plural(nFit, 'format')} concerné${nFit > 1 ? 's' : ''}` : '';
    ui.colorRow.hidden = !active || state.fill.type === 'blur';
    ui.gradientRow.hidden = !active || state.fill.type !== 'gradient';
    ui.fillExtra.hidden = ui.colorRow.hidden && ui.gradientRow.hidden;
    ui.fillColor.value = state.fill.color;
    ui.fillHex.textContent = state.fill.color.toUpperCase();
    const pct = Math.round(state.fill.length * 100);
    ui.fillLength.value = pct;
    ui.fillLengthOut.textContent = `${pct}${NNBSP}%`;
    ui.btnPipette.disabled = !state.img;
    ui.btnPipette.setAttribute('aria-pressed', String(state.mode === 'pick'));
    ui.fillNote.textContent = !active
      ? 'Actif pour les formats en « Conserver le ratio » : le vide autour de l’image est rempli.'
      : state.fill.type === 'blur' ? 'Le vide est rempli par un flou tiré des bords de l’image.'
      : state.fill.type === 'color' ? 'Le vide est rempli par une couleur unie.'
      : 'Le dégradé part des bords de l’image et glisse vers la couleur choisie.';
    for (const f of FORMATS) if (rows[f.id]) rows[f.id].fitInput.checked = isFit(f);
  }

  // ---------------------------------------------------------------------------
  // Liste des formats
  // ---------------------------------------------------------------------------
  const rows = Object.create(null);
  const groupEls = [];

  function buildList() {
    ui.groups.textContent = '';
    for (const g of GROUPS) {
      const list = FORMATS.filter((f) => f.group === g.name);
      if (!list.length) continue;
      const count = el('span', { class: 'group-count' });
      const toggle = el('button', { class: 'btn group-toggle', type: 'button' });
      toggle.addEventListener('click', () => {
        const all = list.every((f) => state.selected.has(f.id));
        for (const f of list) { if (all) state.selected.delete(f.id); else state.selected.add(f.id); }
        saveSelection();
      });
      const box = el('div', { class: 'rows', role: 'list' }, list.map(buildRow));
      ui.groups.append(el('section', { class: 'group' }, [
        el('div', { class: 'group-head' }, [el('h3', { class: 'group-title' }, [g.name + ' ', count]), toggle]),
        box
      ]));
      groupEls.push({ list, count, toggle });
    }
  }

  function buildRow(f) {
    const r = f.width / f.height;
    const check = el('input', { type: 'checkbox', class: 'check', 'aria-label': `Exporter ${f.name}` });
    const shape = el('span', { class: 'thumb-shape' });
    const canvas = el('canvas', { 'aria-hidden': 'true' });
    const box = el('span', { class: 'thumb' }, [shape, canvas]);
    const badges = el('span', { class: 'row-badges' });
    const main = el('button', { class: 'row-main', type: 'button', 'aria-pressed': 'false', 'aria-label': `${f.name}, ${f.width} par ${f.height} pixels : afficher dans l’aperçu` }, [
      box,
      el('span', { class: 'row-text' }, [el('span', { class: 'row-name' }, f.name), el('span', { class: 'row-dims' }, dims(f.width, f.height)), badges])
    ]);
    const fitInput = el('input', { type: 'checkbox', class: 'switch', role: 'switch', 'aria-label': `Conserver le ratio : ${f.name}` });
    const btnSave = el('button', { class: 'icon-btn', type: 'button', 'aria-label': `Télécharger ${f.name}`, title: 'Télécharger ce format' },
      svgIcon(['M12 4v13M7 12l5 5 5-5M4 20h16']));
    const row = el('div', { class: 'row', role: 'listitem', 'data-id': f.id }, [
      check, main,
      el('div', { class: 'row-tools' }, [el('label', { class: 'ratio' }, ['Ratio', fitInput]), btnSave])
    ]);

    check.addEventListener('change', () => {
      if (check.checked) state.selected.add(f.id); else state.selected.delete(f.id);
      saveSelection();
    });
    main.addEventListener('click', () => selectFormat(f.id));
    fitInput.addEventListener('change', () => setFit([f.id], fitInput.checked));
    btnSave.addEventListener('click', () => exportOne(f));
    const hoverOn = () => { if (state.hoverId !== f.id) { state.hoverId = f.id; render(); } };
    const hoverOff = () => { if (state.hoverId === f.id) { state.hoverId = null; render(); } };
    row.addEventListener('pointerenter', hoverOn);
    row.addEventListener('pointerleave', hoverOff);

    rows[f.id] = { row, check, main, box, shape, canvas, badges, fitInput, btnSave, ratio: r, fitKey: null, badgeKey: '' };
    return row;
  }

  function saveSelection() {
    prefs.set('off', FORMATS.filter((x) => !state.selected.has(x.id)).map((x) => x.id));
    render();
  }

  // Taille d'affichage d'une vignette (aux proportions du format, dans la case).
  function thumbSize(t) {
    const inner = Math.max(24, (t.box.clientWidth || 88) - 8);
    return t.ratio >= 1 ? { w: inner, h: Math.max(6, Math.round(inner / t.ratio)) } : { w: Math.max(6, Math.round(inner * t.ratio)), h: inner };
  }

  function drawThumb(f, t) {
    const s = thumbSize(t);
    t.shape.style.width = s.w + 'px';
    t.shape.style.height = s.h + 'px';
    if (!state.img) { t.canvas.hidden = true; return; }
    t.canvas.hidden = false;
    t.canvas.style.width = s.w + 'px';
    t.canvas.style.height = s.h + 'px';
    const w = Math.round(s.w * dpr());
    const h = Math.round(s.h * dpr());
    const cv = t.canvas;
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; t.fitKey = null; }
    const ctx = cv.getContext('2d');
    if (isFit(f)) {
      const key = [state.imgVersion, state.fill.type, state.fill.color, state.fill.length, w, h].join('|');
      if (t.fitKey === key) return;
      t.fitKey = key;
      drawFitComposition(ctx, w, h);
      return;
    }
    t.fitKey = null;
    const c = cropFor(f);
    const k = state.proxyScale;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(state.proxy, c.x * k, c.y * k, c.w * k, c.h * k, 0, 0, w, h);
  }

  function upscaleOf(f) {
    return isFit(f) ? containRect(f.width, f.height, false).scale : cropFor(f).upscale;
  }

  function renderList() {
    const ready = !!state.img;
    for (const f of FORMATS) {
      const t = rows[f.id];
      const on = state.selected.has(f.id);
      t.check.checked = on;
      t.row.classList.toggle('is-off', !on);
      t.row.classList.toggle('is-current', state.mode !== 'focus' && state.currentId === f.id);
      t.main.setAttribute('aria-pressed', String(state.currentId === f.id && state.mode !== 'focus'));
      t.main.disabled = !ready;
      t.btnSave.disabled = !ready || state.busy;
      drawThumb(f, t);
      // Badges : cadrage manuel, photo trop petite
      const up = ready ? upscaleOf(f) : 0;
      const manual = ready && !isFit(f) && !!state.overrides[f.id];
      const key = `${manual}|${up > UPSCALE_WARN ? fmtNum(up) : ''}`;
      if (key !== t.badgeKey) {
        t.badgeKey = key;
        t.badges.textContent = '';
        if (manual) t.badges.append(el('span', { class: 'badge badge-manual' }, 'Cadrage manuel'));
        if (up > UPSCALE_WARN) t.badges.append(el('span', { class: 'badge badge-warn', title: 'La photo d’origine est plus petite que ce format : le résultat peut être flou.' }, `Agrandie ×${fmtNum(up)}`));
      }
    }
    for (const g of groupEls) {
      const n = g.list.filter((f) => state.selected.has(f.id)).length;
      g.count.textContent = `${n} / ${g.list.length}`;
      g.toggle.textContent = n === g.list.length ? 'Tout décocher' : 'Tout cocher';
    }
    const n = FORMATS.filter((f) => state.selected.has(f.id)).length;
    ui.count.textContent = `${n} / ${FORMATS.length}`;
    updateExport(n);
  }

  function updateExport(n) {
    if (n == null) n = FORMATS.filter((f) => state.selected.has(f.id)).length;
    if (!state.busy) ui.zipLabel.textContent = n === 0 ? 'Aucun format coché' : `Télécharger ${plural(n, 'format')} (.zip)`;
    ui.btnZip.disabled = !state.img || n === 0 || state.busy;
    ui.exportHint.textContent = state.img && n === 0 ? 'Cochez au moins un format' : '';
    ui.exportHint.hidden = !ui.exportHint.textContent;
  }

  // ---------------------------------------------------------------------------
  // Zone centrale
  // ---------------------------------------------------------------------------
  let raf = 0;
  function render() {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; renderStage(); renderList(); });
  }

  const current = () => (state.currentId ? byId(state.currentId) : null);
  const showsFitPreview = () => state.mode === 'format' && current() && isFit(current());

  function placeFrame(node, c) {
    node.style.left = (c.x / state.W * 100) + '%';
    node.style.top = (c.y / state.H * 100) + '%';
    node.style.width = (c.w / state.W * 100) + '%';
    node.style.height = (c.h / state.H * 100) + '%';
  }

  function areaSize() {
    return { w: ui.area.clientWidth, h: ui.area.clientHeight };
  }

  function layoutPhoto() {
    if (!state.img) return;
    const a = areaSize();
    if (a.w <= 0 || a.h <= 0) return;
    const s = Math.min(a.w / state.W, a.h / state.H);
    ui.photo.style.width = Math.floor(state.W * s) + 'px';
    ui.photo.style.height = Math.floor(state.H * s) + 'px';
  }

  let fitPreviewKey = null;
  function drawFitPreview(f) {
    const a = areaSize();
    if (a.w <= 0 || a.h <= 0) return;
    const r = f.width / f.height;
    const cw = Math.floor(a.w / a.h > r ? a.h * r : a.w);
    const ch = Math.floor(a.w / a.h > r ? a.h : a.w / r);
    const cv = ui.fitPreview;
    cv.style.width = cw + 'px';
    cv.style.height = ch + 'px';
    const w = Math.round(cw * dpr());
    const h = Math.round(ch * dpr());
    const key = [f.id, state.imgVersion, state.fill.type, state.fill.color, state.fill.length, w, h].join('|');
    if (key === fitPreviewKey) return;
    fitPreviewKey = key;
    cv.width = w;
    cv.height = h;
    drawFitComposition(cv.getContext('2d'), w, h);
  }

  function navList() {
    const list = FORMATS.filter((f) => state.selected.has(f.id));
    return list.length ? list : FORMATS;
  }

  function renderStage() {
    ui.app.dataset.mode = state.mode;
    if (!state.img) return;
    const f = current();
    const mode = state.mode;
    const fitView = showsFitPreview();

    // Photo ou aperçu « ratio conservé »
    ui.photo.hidden = fitView;
    ui.fitPreview.hidden = !fitView;
    if (fitView) drawFitPreview(f); else fitPreviewKey = null;

    // Point de focus
    const fx = state.focus.x * 100 + '%';
    const fy = state.focus.y * 100 + '%';
    ui.focus.style.left = fx;
    ui.focus.style.top = fy;
    ui.spot.style.setProperty('--fx', fx);
    ui.spot.style.setProperty('--fy', fy);
    ui.focus.hidden = mode !== 'focus';

    // Cadre du format sélectionné
    if (mode === 'format' && f && !isFit(f)) {
      placeFrame(ui.edit, cropFor(f));
      ui.edit.hidden = false;
    } else {
      ui.edit.hidden = true;
    }

    // Cadre fantôme au survol d'un format (mode focus)
    const ghost = mode === 'focus' && state.hoverId ? byId(state.hoverId) : null;
    if (ghost) {
      const fit = isFit(ghost);
      placeFrame(ui.ghost, fit ? { x: 0, y: 0, w: state.W, h: state.H } : cropFor(ghost));
      ui.ghostLabel.textContent = `${ghost.name} ${dims(ghost.width, ghost.height)}${fit ? ', image entière' : ''}`;
      ui.ghost.hidden = false;
    } else {
      ui.ghost.hidden = true;
    }

    // En-tête de l'aperçu
    const manual = f && !!state.overrides[f.id];
    ui.btnCenter.hidden = mode !== 'focus';
    ui.btnAuto.hidden = !(mode === 'format' && f && !isFit(f) && manual);
    ui.btnAll.hidden = mode !== 'format';
    ui.btnPickCancel.hidden = mode !== 'pick';
    ui.vhTag.classList.remove('tag-manual');
    ui.vhTag.hidden = mode === 'focus';
    if (mode === 'focus') {
      ui.vhName.textContent = 'Point de focus';
      ui.vhDims.textContent = '';
      ui.hint.textContent = 'Cliquez sur le sujet : toutes les déclinaisons recadrées se recentrent dessus. Survolez un format de la liste pour voir son cadre.';
      ui.photo.setAttribute('aria-label', 'Photo. Cliquez ou utilisez les flèches du clavier pour placer le point de focus.');
    } else if (mode === 'pick') {
      ui.vhName.textContent = 'Pipette';
      ui.vhDims.textContent = '';
      ui.vhTag.textContent = 'Couleur de fond';
      ui.hint.textContent = 'Cliquez sur la photo pour prélever la couleur de fond. Échap pour annuler.';
      ui.photo.setAttribute('aria-label', 'Pipette : cliquez sur la photo pour prélever une couleur. Échap pour annuler.');
    } else if (f) {
      ui.vhName.textContent = f.name;
      ui.vhDims.textContent = dims(f.width, f.height);
      if (isFit(f)) {
        ui.vhTag.textContent = 'Ratio conservé';
        ui.hint.textContent = 'Ce format garde l’image entière ; le fond se règle dans « Fond de remplissage ». Échap : retour à tous les formats.';
      } else {
        ui.vhTag.textContent = manual ? 'Cadrage manuel' : 'Recadré';
        ui.vhTag.classList.toggle('tag-manual', manual);
        ui.hint.textContent = 'Glissez le cadre pour choisir la zone gardée, tirez un coin pour zoomer. Double-clic : cadrage automatique. Échap : tous les formats.';
        ui.photo.setAttribute('aria-label', `Cadrage du format ${f.name}. Flèches pour déplacer le cadre, + et − pour zoomer, Échap pour revenir à tous les formats.`);
      }
    }

    // Navigation entre formats
    const list = navList();
    const i = f && mode === 'format' ? list.indexOf(f) : -1;
    ui.navCount.textContent = mode === 'format' ? `${i >= 0 ? i + 1 : '–'} / ${list.length}` : `${list.length} formats`;
  }

  // ---------------------------------------------------------------------------
  // Modes
  // ---------------------------------------------------------------------------
  function selectFormat(id) {
    if (!state.img || state.busy) return;
    if (state.mode === 'pick') exitPick(true);
    state.mode = 'format';
    state.currentId = id;
    state.hoverId = null;
    renderSettings();
    render();
  }

  function showAll() {
    state.mode = 'focus';
    state.currentId = null;
    renderSettings();
    render();
  }

  function navigate(step) {
    if (!state.img) return;
    const list = navList();
    const f = current();
    let i = state.mode === 'format' && f ? list.indexOf(f) : -1;
    if (i < 0) i = step > 0 ? -1 : list.length;
    i = (i + step + list.length) % list.length;
    selectFormat(list[i].id);
    rows[list[i].id].row.scrollIntoView({ block: 'nearest' });
  }

  // ---------------------------------------------------------------------------
  // Pipette
  // ---------------------------------------------------------------------------
  const LOUPE_PX = 15;     // pixels de la photo visibles dans la loupe
  const LOUPE_SIZE = 112;  // taille de la loupe (px CSS)

  function enterPick() {
    if (!state.img || state.busy) return;
    if (state.mode !== 'pick') state.pickReturn = { mode: state.mode, id: state.currentId };
    state.mode = 'pick';
    state.hoverId = null;
    renderSettings();
    render();
    ui.photo.focus({ preventScroll: true });
  }

  function exitPick(silent) {
    if (state.mode !== 'pick') return;
    const back = state.pickReturn || { mode: 'focus', id: null };
    state.pickReturn = null;
    state.mode = back.mode === 'format' && back.id ? 'format' : 'focus';
    state.currentId = state.mode === 'format' ? back.id : null;
    ui.loupe.hidden = true;
    if (!silent) { renderSettings(); render(); }
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
    const size = Math.round(LOUPE_SIZE * dpr());
    const cv = ui.loupeCanvas;
    if (cv.width !== size) { cv.width = size; cv.height = size; }
    const ctx = cv.getContext('2d');
    const cx = Math.floor(p.x * pr.width);
    const cy = Math.floor(p.y * pr.height);
    const half = Math.floor(LOUPE_PX / 2);
    const cell = size / LOUPE_PX;
    ctx.fillStyle = '#111111';
    ctx.fillRect(0, 0, size, size);
    ctx.imageSmoothingEnabled = false;
    const sx = cx - half, sy = cy - half;
    const vx0 = Math.max(0, sx), vy0 = Math.max(0, sy);
    const vx1 = Math.min(pr.width, sx + LOUPE_PX), vy1 = Math.min(pr.height, sy + LOUPE_PX);
    if (vx1 > vx0 && vy1 > vy0) {
      ctx.drawImage(pr, vx0, vy0, vx1 - vx0, vy1 - vy0, (vx0 - sx) * cell, (vy0 - sy) * cell, (vx1 - vx0) * cell, (vy1 - vy0) * cell);
    }
    ctx.lineWidth = Math.max(1.5, dpr() * 1.5);
    ctx.strokeStyle = '#ffffff';
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
    if (ly + LOUPE_SIZE + 32 > area.height - 4) ly = e.clientY - area.top - 22 - LOUPE_SIZE - 32;
    ui.loupe.style.left = lx + 'px';
    ui.loupe.style.top = ly + 'px';
    ui.loupe.hidden = false;
  }

  // ---------------------------------------------------------------------------
  // Ouverture et retrait de la photo
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

  function drawFileThumb() {
    const cv = ui.fileThumb;
    const ctx = cv.getContext('2d');
    const s = Math.max(cv.width / state.W, cv.height / state.H);
    const w = state.W * s;
    const h = state.H * s;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.drawImage(state.proxy, (cv.width - w) / 2, (cv.height - h) / 2, w, h);
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
      state.mode = 'focus';
      state.currentId = null;
      state.pickReturn = null;
      state.imgVersion++;
      buildProxy();
      state.fill.color = measureColors();   // couleur proposée : la moyenne des bords

      ui.photoImg.src = url;
      ui.basename.value = slugify(stripExt(state.fileName)) || 'visuel';
      ui.metaName.textContent = state.fileName;
      ui.metaDims.textContent = `${dims(state.W, state.H)} px`;
      drawFileThumb();
      ui.app.dataset.state = 'ready';
      ui.dropzone.hidden = true;
      ui.viewer.hidden = false;
      ui.sideIntro.textContent = 'Cliquez sur un format pour l’afficher et ajuster son cadrage.';
      renderSettings();
      layoutPhoto();
      render();
    } catch (err) {
      console.error(err);
      toast('Impossible d’ouvrir ce fichier. Utilisez une photo JPG, PNG, WebP ou HEIC.', 'error');
    } finally {
      state.loading = false;
      showStatus('');
      ui.fileInput.value = '';
    }
  }

  function removePhoto() {
    if (state.busy || !state.img) return;
    if (state.url) URL.revokeObjectURL(state.url);
    Object.assign(state, { img: null, url: null, W: 0, H: 0, fileName: '', proxy: null, mode: 'focus', currentId: null, hoverId: null, pickReturn: null });
    state.overrides = Object.create(null);
    state.imgVersion++;
    ui.photoImg.removeAttribute('src');
    ui.app.dataset.state = 'empty';
    ui.viewer.hidden = true;
    ui.dropzone.hidden = false;
    ui.loupe.hidden = true;
    ui.basename.value = '';
    ui.sideIntro.textContent = 'Chaque photo est déclinée dans les formats cochés.';
    renderSettings();
    render();
    ui.btnPick.focus();
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
    const out = makeCanvas(tw, th);
    await resizeHQ(inter, out);
    inter.width = inter.height = 0;
    return out;
  }

  // « Conserver le ratio » : fond (flou, couleur ou dégradé) + image entière centrée.
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
    const png = state.format === 'png';
    if (!png) {   // fond blanc pour le JPG : pas de transparence
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
    ui.btnNew.disabled = on;
    ui.btnRemove.disabled = on;
    render();
    updateExport();
  }

  async function exportZip() {
    const list = FORMATS.filter((f) => state.selected.has(f.id));
    if (!state.img || !list.length || state.busy) return;
    if (state.mode === 'pick') exitPick();
    setBusy(true);
    const base = currentBase();
    try {
      const zip = new window.JSZip();
      for (let i = 0; i < list.length; i++) {
        ui.zipLabel.textContent = `Préparation ${i + 1}/${list.length}…`;
        await nextFrame();
        zip.file(fileNameFor(list[i], base), await renderOutput(list[i]));
      }
      ui.zipLabel.textContent = 'Création du .zip…';
      await nextFrame();
      const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
      const name = `${base}_declinaisons.zip`;
      saveBlob(blob, name);
      toast(`${plural(list.length, 'format')} téléchargé${list.length > 1 ? 's' : ''} dans ${name}`);
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

  // Poignée sous le pointeur ('nw' | 'ne' | 'sw' | 'se') ou null.
  function handleAt(e, c) {
    const r = ui.photo.getBoundingClientRect();
    const k = r.width / state.W;
    const mx = e.clientX - r.left;
    const my = e.clientY - r.top;
    const corners = { nw: [c.x, c.y], ne: [c.x + c.w, c.y], sw: [c.x, c.y + c.h], se: [c.x + c.w, c.y + c.h] };
    for (const name in corners) {
      const [x, y] = corners[name];
      if (Math.abs(mx - x * k) <= HANDLE_HIT && Math.abs(my - y * k) <= HANDLE_HIT) return name;
    }
    return null;
  }

  function editable() {
    const f = current();
    return state.mode === 'format' && f && !isFit(f) ? f : null;
  }

  ui.photo.addEventListener('pointerdown', (e) => {
    if (!state.img || e.button > 0) return;
    e.preventDefault();
    ui.photo.focus({ preventScroll: true });
    const p = pointerToNorm(e);
    if (state.mode === 'pick') {
      const hex = sampleAt(p);
      exitPick();
      setFill(colorMode(), hex);
      toast(`Couleur de fond prélevée : ${hex.toUpperCase()}`);
      return;
    }
    ui.photo.setPointerCapture(e.pointerId);
    if (state.mode === 'focus') {
      drag = { type: 'focus' };
      clearTimeout(placingTimer);
      ui.photo.classList.add('is-placing');
      setFocus(p);
      return;
    }
    const f = editable();
    if (!f) return;
    const c = cropFor(f);
    const hit = handleAt(e, c);
    if (hit) {
      // Le coin opposé reste fixe pendant le zoom
      const ax = hit.includes('w') ? c.x + c.w : c.x;
      const ay = hit.includes('n') ? c.y + c.h : c.y;
      drag = { type: 'resize', ax, ay, sx: hit.includes('w') ? -1 : 1, sy: hit.includes('n') ? -1 : 1 };
      ensureOverride(f);
      return;
    }
    const px = p.x * state.W;
    const py = p.y * state.H;
    const inside = px >= c.x && px <= c.x + c.w && py >= c.y && py <= c.y + c.h;
    if (inside) {
      drag = { type: 'frame', dx: c.x + c.w / 2 - px, dy: c.y + c.h / 2 - py };
    } else {
      drag = { type: 'frame', dx: 0, dy: 0 };
      setOverrideCenter(f, px, py);
    }
  });

  ui.photo.addEventListener('pointermove', (e) => {
    if (state.mode === 'pick' && state.img) { updateLoupe(e); return; }
    const f = editable();
    if (!drag) {
      // Curseur adapté : poignée, intérieur du cadre, extérieur
      if (f) {
        const c = cropFor(f);
        const hit = handleAt(e, c);
        const p = pointerToNorm(e);
        const inside = p.x * state.W >= c.x && p.x * state.W <= c.x + c.w && p.y * state.H >= c.y && p.y * state.H <= c.y + c.h;
        ui.photo.style.cursor = hit ? (hit === 'nw' || hit === 'se' ? 'nwse-resize' : 'nesw-resize') : inside ? 'move' : 'crosshair';
      } else {
        ui.photo.style.cursor = '';
      }
      return;
    }
    const p = pointerToNorm(e);
    if (drag.type === 'focus') { setFocus(p); return; }
    if (!f) return;
    if (drag.type === 'frame') {
      setOverrideCenter(f, p.x * state.W + drag.dx, p.y * state.H + drag.dy);
    } else if (drag.type === 'resize') {
      const b = baseSize(f);
      const ratio = f.width / f.height;
      const w = clamp(Math.max(Math.abs(p.x * state.W - drag.ax), Math.abs(p.y * state.H - drag.ay) * ratio), b.w / MAX_ZOOM, b.w);
      const h = w / ratio;
      const o = ensureOverride(f);
      o.zoom = clamp(b.w / w, 1, MAX_ZOOM);
      setOverrideCenter(f, drag.ax + drag.sx * w / 2, drag.ay + drag.sy * h / 2);
    }
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

  ui.photo.addEventListener('dblclick', (e) => {
    const f = editable();
    if (!f) return;
    e.preventDefault();
    resetOverride(f);
  });

  ui.photo.addEventListener('wheel', (e) => {
    const f = editable();
    if (!f) return;
    e.preventDefault();
    const o = ensureOverride(f);
    setZoom(f, o.zoom * Math.exp(-e.deltaY * 0.0015));
  }, { passive: false });

  ui.photo.addEventListener('keydown', (e) => {
    if (!state.img || state.mode === 'pick') return;
    const f = editable();
    if (f && (e.key === '+' || e.key === '=' || e.key === '-' || e.key === '−')) {
      e.preventDefault();
      const o = ensureOverride(f);
      setZoom(f, o.zoom * (e.key === '-' || e.key === '−' ? 1 / 1.1 : 1.1));
      return;
    }
    const step = e.shiftKey ? 0.05 : 0.01;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (!d) return;
    e.preventDefault();
    if (state.mode === 'focus') {
      setFocus({ x: state.focus.x + d[0], y: state.focus.y + d[1] });
    } else if (f) {
      const o = ensureOverride(f);
      setOverrideCenter(f, (o.cx + d[0]) * state.W, (o.cy + d[1]) * state.H);
    }
  });

  // ---------------------------------------------------------------------------
  // Commandes
  // ---------------------------------------------------------------------------
  ui.btnCenter.addEventListener('click', () => setFocus({ x: 0.5, y: 0.5 }));
  ui.btnAuto.addEventListener('click', () => { const f = current(); if (f) resetOverride(f); });
  ui.btnAll.addEventListener('click', showAll);
  ui.btnPickCancel.addEventListener('click', () => exitPick());
  ui.btnPrev.addEventListener('click', () => navigate(-1));
  ui.btnNext.addEventListener('click', () => navigate(1));

  // Anneau de focus de la photo : seulement au clavier
  document.addEventListener('keydown', () => { document.documentElement.dataset.input = 'kb'; }, true);
  document.addEventListener('pointerdown', () => { document.documentElement.dataset.input = 'mouse'; }, true);

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (state.mode === 'pick') { e.preventDefault(); exitPick(); }
    else if (state.mode === 'format') { e.preventDefault(); showAll(); }
  });

  ui.allCrop.addEventListener('click', () => setFit(FORMATS.map((f) => f.id), false));
  ui.allFit.addEventListener('click', () => setFit(FORMATS.map((f) => f.id), true));
  for (const r of ui.fillSeg.querySelectorAll('input')) {
    r.addEventListener('change', () => { if (r.checked) setFill(r.value); });
  }
  ui.fillColor.addEventListener('input', () => setFill(colorMode(), ui.fillColor.value));
  ui.fillLength.addEventListener('input', () => setFill(null, null, ui.fillLength.value / 100));
  ui.btnPipette.addEventListener('click', () => (state.mode === 'pick' ? exitPick() : enterPick()));

  ui.btnPick.addEventListener('click', () => ui.fileInput.click());
  ui.btnNew.addEventListener('click', () => ui.fileInput.click());
  ui.btnRemove.addEventListener('click', removePhoto);
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
  ui.basename.addEventListener('blur', () => { if (state.img) ui.basename.value = currentBase(); });

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

  const onResize = () => { layoutPhoto(); render(); };
  if (window.ResizeObserver) new ResizeObserver(onResize).observe(ui.area);
  window.addEventListener('resize', onResize);

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
    const ft = prefs.get('fill', 'blur');
    state.fill.type = ['blur', 'color', 'gradient'].includes(ft) ? ft : 'blur';
    const fl = Number(prefs.get('fillLength', 0.6));
    state.fill.length = clamp(Number.isFinite(fl) ? fl : 0.6, 0.2, 1);

    if (!FORMATS.length) ui.sideIntro.textContent = 'Aucun format défini. Ajoutez des formats dans le fichier js/formats.js.';
    buildList();
    renderSettings();
    renderList();
    renderStage();

    // Accès pour les tests automatisés
    window.Declinator = { state, cropFor, containRect, FORMATS, loadFile };
  })();
})();
