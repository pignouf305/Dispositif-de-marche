(function() {
  "use strict";

  // ============================================================
  // État global centralisé
  // ============================================================
  const state = {
    pts: [],
    wpts: [],
    trackName: '',
    trackDate: new Date(),
    trackAuthor: '',
    cumDist: [],
    cumDistEffort: [],
    totalDist: 0,
    totalDistEffort: 0,
    gainPos: 0,
    gainNeg: 0,
    hasEle: false,
    eles: [],
    mapInst: null,
    elevCI: null,
    markerGroup: null,
    isAddingMarker: false,
    isDrawingTrack: false,
    isRouting: false,
    ignoreMapClickUntil: 0,
  };

  // Sauvegarde de l'état précédent (pour annuler le dessin de tracé)
  let previousState = null;

  function savePreviousState() {
    let mapView = { center: [46.2044, 6.1432], zoom: 13 };
    if (state.mapInst) {
      const c = state.mapInst.getCenter();
      mapView = { center: [c.lat, c.lng], zoom: state.mapInst.getZoom() };
    }
    previousState = {
      pts: state.pts.map(p => ({ ...p })),
      wpts: state.wpts.map(w => ({ ...w })),
      trackName: state.trackName,
      trackDate: new Date(state.trackDate),
      trackAuthor: state.trackAuthor,
      cumDist: [...state.cumDist],
      cumDistEffort: [...state.cumDistEffort],
      totalDist: state.totalDist,
      totalDistEffort: state.totalDistEffort,
      gainPos: state.gainPos,
      gainNeg: state.gainNeg,
      hasEle: state.hasEle,
      eles: [...state.eles],
      speed: $('#speedInput').value,
      startTime: $('#startTimeInput').value,
      trackDateValue: $('#track-date').value,
      mapView,
    };
  }
  // Configuration routing (Cloudflare Worker)
  // ============================================================
  // IMPORTANT : remplacez par l'URL de votre Worker après déploiement.
  // Les instructions de déploiement sont dans proxy-worker.js
  const WORKER_URL = 'https://ors-proxy.bariboule.workers.dev/';
  const WORKER_CONFIGURED = /^https:\/\/[^\/]+\.workers\.dev\/?$/i.test(WORKER_URL);
  if (!WORKER_CONFIGURED) {
    console.warn('%c[ROUTING] Worker ORS non configuré. Éditez WORKER_URL dans app.js (ligne ~35).', 'color:orange;font-weight:bold');
  } else {
    console.log('%c[ROUTING] Worker ORS configuré : ' + WORKER_URL, 'color:green');
  }
  // ============================================================
  // Helpers DOM
  // ============================================================
  const $  = (sel, ctx = document) => ctx.querySelector(sel);
  const $$ = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel));

  function escapeHtml(unsafe) {
    if (unsafe == null) return '';
    const div = document.createElement('div');
    div.textContent = String(unsafe);
    return div.innerHTML;
  }

  function escapeXml(unsafe) {
    return String(unsafe).replace(/[<>&'"]/g, c => {
      switch (c) {
        case '<': return '&lt;';
        case '>': return '&gt;';
        case '&': return '&amp;';
        case '\'': return '&apos;';
        case '"': return '&quot;';
      }
      return c;
    });
  }

  // ============================================================
  // Compression / Encodage URL
  // ============================================================
  function supportsCompression() {
    return typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';
  }

  async function compressToBase64(str) {
    const encoded = new TextEncoder().encode(str);
    const stream = new ReadableStream({
      start(controller) { controller.enqueue(encoded); controller.close(); }
    }).pipeThrough(new CompressionStream('deflate-raw'));
    const compressed = await new Response(stream).arrayBuffer();
    const bytes = new Uint8Array(compressed);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  async function decompressFromBase64(b64) {
    b64 = b64.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const stream = new ReadableStream({
      start(controller) { controller.enqueue(bytes); controller.close(); }
    }).pipeThrough(new DecompressionStream('deflate-raw'));
    const decompressed = await new Response(stream).arrayBuffer();
    return new TextDecoder().decode(decompressed);
  }

  function simplifyPoints(pts) {
    const MAX = 500;
    if (pts.length <= MAX) return pts;
    const step = Math.ceil(pts.length / MAX);
    const simplified = [];
    simplified.push(pts[0]);
    for (let i = step; i < pts.length - 1; i += step) simplified.push(pts[i]);
    simplified.push(pts[pts.length - 1]);
    return simplified;
  }

  // ============================================================
  // Math / Géo
  // ============================================================
  function haversine(a, b) {
    const R = 6371000;
    const toR = x => x * Math.PI / 180;
    const dLat = toR(b.lat - a.lat);
    const dLon = toR(b.lon - a.lon);
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a.lat)) * Math.cos(toR(b.lat)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
  }

  function computeMN03(lat, lon) {
    const lat2 = (lat * 3600 - 169028.66) / 10000;
    const lon2 = (lon * 3600 - 26782.5) / 10000;
    const x = Math.floor((2600072.37 + 211455.93 * lon2 - 10938.51 * lon2 * lat2 - 0.36 * lon2 * lat2 * lat2 - 44.54 * lon2 * lon2 * lon2) - 2000000) / 1000;
    const y = Math.floor((1200147.07 + 308807.95 * lat2 + 3745.25 * lon2 * lon2 + 76.63 * lat2 * lat2 - 194.56 * lon2 * lon2 * lat2 + 119.79 * lat2 * lat2 * lat2) - 1000000) / 1000;
    return { x, y };
  }

  // ============================================================
  // UI : erreurs
  // ============================================================
  function showError(msg) {
    $('#errorMsg').textContent = msg;
    $('#errorMsg').style.display = 'block';
  }

  function clearError() {
    $('#errorMsg').style.display = 'none';
    $('#errorMsg').textContent = '';
  }

  // ============================================================
  // Parsing GPX
  // ============================================================
  function parseGPX(text, filename) {
    const xml = new DOMParser().parseFromString(text, 'application/xml');
    const parseErr = xml.querySelector('parsererror');
    if (parseErr) throw new Error('Le fichier XML est mal formé.');

    const nameEl = xml.querySelector('metadata name, name');
    state.trackName = nameEl ? nameEl.textContent.trim() : filename.replace(/\.gpx$/i, '');

    const timeEl = xml.querySelector('metadata time, time');
    state.trackDate = timeEl ? new Date(timeEl.textContent) : new Date();

    const authorEl = xml.querySelector('metadata author, author');
    state.trackAuthor = authorEl ? authorEl.textContent.trim() : '';

    const speedEl = xml.querySelector('metadata extensions asg speed');
    if (speedEl) {
      const s = parseFloat(speedEl.textContent);
      if (!isNaN(s)) $('#speedInput').value = s;
    }

    const trkpts = Array.from(xml.querySelectorAll('trkpt'));
    if (!trkpts.length) throw new Error('Aucun point de trace (trkpt) trouvé dans ce fichier.');

    state.pts = trkpts.map(pt => {
      const lat = parseFloat(pt.getAttribute('lat'));
      const lon = parseFloat(pt.getAttribute('lon'));
      const eleEl = pt.querySelector('ele');
      const ele = eleEl ? parseFloat(eleEl.textContent) : 0;
      return { lat, lon, ele };
    }).filter(p => !isNaN(p.lat) && !isNaN(p.lon));

    if (!state.pts.length) throw new Error('Les coordonnées GPS sont invalides.');

    const wptEls = Array.from(xml.querySelectorAll('wpt'));
    state.wpts = wptEls.map((w, i) => {
      const lat = parseFloat(w.getAttribute('lat'));
      const lon = parseFloat(w.getAttribute('lon'));
      const name = w.querySelector('name')?.textContent.trim() || ('WPT ' + (i + 1));
      const desc = w.querySelector('desc')?.textContent.trim() || '';
      const cmt = w.querySelector('cmt')?.textContent.trim() || '';
      const eleEl = w.querySelector('ele');
      const ele = eleEl ? parseFloat(eleEl.textContent) : null;
      const timeEl = w.querySelector('extensions asg breakTimeMin');
      const brkT = timeEl ? parseFloat(timeEl.textContent) : 0;
      return { lat, lon, name, desc, cmt, ele, brkT };
    }).filter(w => !isNaN(w.lat) && !isNaN(w.lon));
  }

  // ============================================================
  // Calculs trace
  // ============================================================
  function computeTrackMetrics() {
    state.gainPos = 0;
    state.gainNeg = 0;
    state.cumDist = [0];
    state.cumDistEffort = [0];
    state.eles = state.pts.map(p => p.ele);
    state.hasEle = state.eles.some(e => e !== 0);

    for (let i = 1; i < state.pts.length; i++) {
      const d = haversine(state.pts[i - 1], state.pts[i]);
      state.cumDist.push(state.cumDist[i - 1] + d);

      const de = state.pts[i].ele - state.pts[i - 1].ele;
      if (de > 0) state.gainPos += de; else state.gainNeg += Math.abs(de);

      const dEff = d + ((de > 0) ? (de * 10) : (de * -3));
      state.cumDistEffort.push(state.cumDistEffort[i - 1] + dEff);
    }

    state.totalDist = state.cumDist[state.cumDist.length - 1];
    state.totalDistEffort = state.cumDistEffort[state.cumDistEffort.length - 1];
  }

  function snapWaypointsToTrack() {
    state.wpts.forEach(w => {
      let bestIdx = 0, bestDist = Infinity;
      for (let i = 0; i < state.pts.length; i++) {
        const d = haversine(state.pts[i], w);
        if (d < bestDist) { bestDist = d; bestIdx = i; }
      }
      w.nearestIdx = bestIdx;
      w.nearestDist = bestDist;
      w.distFromStart = state.cumDist[bestIdx];
      w.distEffortFromStart = state.cumDistEffort[bestIdx];
      w.trkptEle = state.pts[bestIdx].ele;
    });
    state.wpts.sort((a, b) => a.distFromStart - b.distFromStart);
  }

  // ============================================================
  // Affichage dashboard
  // ============================================================
  function showDashboard() {
    const upload = $('#upload-section');
    if (upload) upload.style.display = 'none';
    $('#dashboard').style.display = 'block';
    $('#track-name').value = state.trackName;
    $('#track-author').value = state.trackAuthor;

    const d = state.trackDate;
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    $('#track-date').value = `${yyyy}-${mm}-${dd}`;

    // Synchroniser l'heure de départ depuis trackDate
    const startInp = $('#startTimeInput');
    startInp.value = state.trackDate.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    delete startInp.dataset.userModified;
  }

  function getDurationStr(kmeh) {
    if (!kmeh || kmeh <= 0) return '—';
    const distKme = state.totalDistEffort / 1000;
    const totalMin = (distKme / kmeh) * 60;
    const h = Math.floor(totalMin / 60);
    const m = Math.round(totalMin % 60);
    return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
  }

  function updateUIState() {
    const hasData = state.pts.length > 0;
    const method = hasData ? 'remove' : 'add';
    $('#statsGrid').classList[method]('dimmed');
    $('#elev-panel').classList[method]('dimmed');
    $('#wpt-panel').classList[method]('dimmed');

    const titleWrap = $('.track-title-wrap');
    if (titleWrap) titleWrap.classList[method]('dimmed');

    const actionRight = $('.dash-actions-right');
    if (actionRight) actionRight.classList[method]('dimmed');

    const headerBottom = $('.dash-header-bottom');
    if (headerBottom) headerBottom.classList[method]('dimmed');
  }

  function renderStats() {
    const kmeh = parseFloat($('#speedInput').value) || 4.6;
    const durationStr = getDurationStr(kmeh);

    const stats = [
      { label: 'Distance', value: (state.totalDist / 1000).toFixed(2), unit: 'km' },
      { label: 'Distance eff.', value: (state.totalDistEffort / 1000).toFixed(2), unit: 'kme', accent: true },
      { label: 'Durée sans pause', value: durationStr, unit: '', accent: true },
      { label: 'Dénivelé +', value: state.hasEle ? Math.round(state.gainPos) : '—', unit: state.hasEle ? 'm' : '' },
      { label: 'Dénivelé −', value: state.hasEle ? Math.round(state.gainNeg) : '—', unit: state.hasEle ? 'm' : '' },
      { label: 'Alt. min', value: state.hasEle ? Math.round(Math.min(...state.eles)) : '—', unit: state.hasEle ? 'm' : '' },
      { label: 'Alt. max', value: state.hasEle ? Math.round(Math.max(...state.eles)) : '—', unit: state.hasEle ? 'm' : '' },
      { label: 'Points GPS', value: state.pts.length.toLocaleString('fr-FR'), unit: '' },
    ];

    $('#statsGrid').innerHTML = stats.map(s => `
      <div class="stat-card${s.accent ? ' accent' : ''}">
        <div class="stat-label">${s.label}</div>
        <div class="stat-value">${s.value}<span class="stat-unit">${s.unit}</span></div>
      </div>`).join('');
  }

  // ============================================================
  // Carte
  // ============================================================
  function createMap(opts = {}) {
    setTimeout(() => {
      if (state.mapInst) { state.mapInst.remove(); state.mapInst = null; }

      const carteosm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        maxZoom: 19
      });

      const carteSwissTopo = L.tileLayer('https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.pixelkarte-farbe/default/current/3857/{z}/{x}/{y}.jpeg', {
        attribution: '&copy; <a href="https://www.swisstopo.admin.ch/">swisstopo</a>',
        minZoom: 2, maxZoom: 18,
        bounds: [[45.398181, 5.140242], [48.230651, 11.47757]]
      });

      const carteSwissTopoSat = L.tileLayer('https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.swissimage/default/current/3857/{z}/{x}/{y}.jpeg', {
        attribution: '&copy; <a href="https://www.swisstopo.admin.ch/">swisstopo</a>',
        minZoom: 2, maxZoom: 19,
        bounds: [[45.398181, 5.140242], [48.230651, 11.47757]]
      });

      const OpenTopoMap = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
        maxZoom: 17,
        attribution: 'Map data: &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, <a href="http://viewfinderpanoramas.org">SRTM</a> | Map style: &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (<a href="https://creativecommons.org/licenses/by-sa/3.0/">CC-BY-SA</a>)'
      });

      state.mapInst = L.map('map', { zoomControl: true, layers: [carteSwissTopo] });
      state.mapInst.doubleClickZoom.disable();

      const fsOpenIcon = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>';
      const fsCloseIcon = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"/></svg>';

      const FullscreenControl = L.Control.extend({
        options: { position: 'topleft' },
        onAdd: function(map) {
          const container = L.DomUtil.create('div', 'leaflet-bar leaflet-control fullscreen-btn');
          const btn = L.DomUtil.create('a', '', container);
          btn.href = '#';
          btn.title = 'Plein écran';
          btn.setAttribute('role', 'button');
          btn.setAttribute('aria-label', 'Plein écran');
          btn.innerHTML = fsOpenIcon;

          const toggleFs = () => {
            const mapEl = document.getElementById('map');
            if (!document.fullscreenElement) {
              mapEl.requestFullscreen().catch(err => console.warn('Fullscreen error:', err));
            } else {
              document.exitFullscreen();
            }
          };

          L.DomEvent.on(btn, 'click', function(e) {
            L.DomEvent.stopPropagation(e);
            L.DomEvent.preventDefault(e);
            toggleFs();
          });

          const updateIcon = () => {
            const isFs = !!document.fullscreenElement;
            btn.title = isFs ? 'Quitter le plein écran' : 'Plein écran';
            btn.setAttribute('aria-label', btn.title);
            btn.innerHTML = isFs ? fsCloseIcon : fsOpenIcon;
          };

          document.addEventListener('fullscreenchange', updateIcon);
          map.on('unload', () => document.removeEventListener('fullscreenchange', updateIcon));
          return container;
        }
      });
      state.mapInst.addControl(new FullscreenControl());

      L.control.layers({
        'Swisstopo': carteSwissTopo,
        'Swisstopo Satellite': carteSwissTopoSat,
        'Open Topo': OpenTopoMap,
        'OSM': carteosm,
      }, null, null).addTo(state.mapInst);

      state.markerGroup = L.layerGroup().addTo(state.mapInst);

      // Listener unique pour l'ajout de marqueur ou le dessin de tracé
      state.mapInst.on('click', e => {
        if (Date.now() < state.ignoreMapClickUntil) return;
        if (state.isAddingMarker) {
          addManualMarker(e.latlng.lat, e.latlng.lng);
        } else if (state.isDrawingTrack) {
          addTrackPoint(e.latlng.lat, e.latlng.lng);
        }
      });

      if (opts.initialView) {
        state.mapInst.setView(opts.initialView.center, opts.initialView.zoom);
      }

      updateMapCursor();
      drawMarkers(true);
    }, 150);
  }

  function updateMapCursor() {
    if (!state.mapInst) return;
    const container = state.mapInst.getContainer();
    if (state.isDrawingTrack || state.isAddingMarker) {
      container.style.cursor = 'crosshair';
      state.mapInst.doubleClickZoom.disable();
    } else {
      container.style.cursor = '';
      state.mapInst.doubleClickZoom.enable();
    }
  }

  function drawMarkers(fit = false) {
    if (!state.mapInst) return;

    const lls = state.pts.map(p => [p.lat, p.lon]);
    state.markerGroup.clearLayers();

    if (lls.length >= 2) {
      const poly = L.polyline(lls, { color: '#3d5af1', weight: 3.5, opacity: 0.9 });
      state.markerGroup.addLayer(poly);
      if (fit) state.mapInst.fitBounds(poly.getBounds(), { padding: [24, 24] });
    } else if (lls.length === 1 && fit) {
      state.mapInst.setView(lls[0], 15);
    }

    const mkIcon = (bg) => L.divIcon({
      html: `<div style="width:12px;height:12px;background:${bg};border-radius:50%;border:2.5px solid white;box-shadow:0 1px 4px rgba(0,0,0,.35)"></div>`,
      iconSize: [12, 12], iconAnchor: [6, 6], className: ''
    });

    if (lls.length) {
      state.markerGroup.addLayer(L.marker(lls[0], { icon: mkIcon('#1a9e6e') }).bindPopup('Départ'));
      if (lls.length > 1) {
        state.markerGroup.addLayer(L.marker(lls[lls.length - 1], { icon: mkIcon('#e05a2b') }).bindPopup('Arrivée'));
      }
    }

    state.wpts.forEach((w, i) => {
      const popupParts = [`<strong>${escapeHtml(w.name)}</strong>`];
      if (w.desc) popupParts.push(`<br><span style="font-size:12px;color:#888">${escapeHtml(w.desc)}</span>`);
      if (w.trkptEle !== null) popupParts.push(`<br><span style="font-size:11px;font-family:monospace;color:#aaa">${Math.round(w.trkptEle)} m</span>`);
      const wptIcon = L.divIcon({
        html: `<div style="position:relative;width:22px;height:22px;">
          <div style="position:absolute;top:0;left:0;width:22px;height:22px;background:#e05a2b;border-radius:3px;border:2px solid white;box-shadow:0 1px 4px rgba(0,0,0,.35);transform:rotate(45deg);"></div>
          <div style="position:absolute;top:0;left:0;width:22px;height:22px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:white;font-family:var(--mono);text-shadow:0 1px 2px rgba(0,0,0,.3);">${i + 1}</div>
        </div>`,
        iconSize: [22, 22], iconAnchor: [11, 11], className: ''
      });
      state.markerGroup.addLayer(L.marker([w.lat, w.lon], { icon: wptIcon }).bindPopup(popupParts.join('')));
    });
  }

  function toggleAddMarker() {
    state.isAddingMarker = !state.isAddingMarker;
    const btn = $('#btn-add-marker');
    btn.classList.toggle('active', state.isAddingMarker);
    btn.textContent = state.isAddingMarker ? '❌ Annuler' : '📍 Ajouter un marqueur';
    updateMapCursor();
    if (state.isAddingMarker) $('#map').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function addManualMarker(lat, lng) {
    state.wpts.push({
      lat, lon: lng,
      name: "Point Ajouté",
      desc: "Ajouté manuellement",
      cmt: "",
      ele: null,
      brkT: 0
    });
    snapWaypointsToTrack();
    renderWptTable();
    drawMarkers(false); // on ne refit pas les bounds pour garder la vue actuelle
    toggleAddMarker();
  }

  const wptMarkersPlugin = {
    id: 'wptMarkers',
    afterDatasetsDraw(chart) {
      if (!state.wpts.length) return;
      const { ctx, scales: { x, y } } = chart;
      const size = 15;
      state.wpts.forEach((w, i) => {
        const distKm = w.distFromStart / 1000;
        const ele = w.trkptEle !== null ? w.trkptEle : (w.ele !== null ? w.ele : 0);
        const px = x.getPixelForValue(distKm);
        const py = y.getPixelForValue(ele);
        if (px === null || py === null || isNaN(px) || isNaN(py)) return;
        ctx.save();
        ctx.translate(px, py);
        ctx.rotate(Math.PI / 4);
        ctx.fillStyle = '#e05a2b';
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1;
        ctx.shadowColor = 'rgba(0,0,0,0.25)';
        ctx.shadowBlur = 3;
        ctx.beginPath();
        ctx.rect(-size / 2, -size / 2, size, size);
        ctx.fill();
        ctx.stroke();
        ctx.rotate(-Math.PI / 4);
        ctx.shadowColor = 'transparent';
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 10px "DM Mono", monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(i + 1), 0, 1);
        ctx.restore();
      });
    }
  };

  // ============================================================
  // Graphique altitude
  // ============================================================
  function createChart() {
    if (state.elevCI) { state.elevCI.destroy(); state.elevCI = null; }

    const canvas = $('#elevChart');
    const panel = canvas.closest('.panel');
    panel.querySelector('.no-ele-msg')?.remove();

    if (!state.hasEle) {
      const p = document.createElement('p');
      p.className = 'no-ele-msg';
      p.style.cssText = 'padding:1rem;font-size:13px;color:#8a8880;';
      p.textContent = "Pas de données d'altitude dans ce fichier.";
      panel.querySelector('.panel-header').insertAdjacentElement('afterend', p);
      return;
    }

    const MAX = 400;
    const step = Math.max(1, Math.floor(state.pts.length / MAX));
    const indices = state.pts.map((_, i) => i).filter(i => i % step === 0);
    const lastIdx = state.pts.length - 1;
    if (lastIdx % step !== 0) indices.push(lastIdx);

    const spts = indices.map(i => state.pts[i]);
    const cds = indices.map(i => parseFloat((state.cumDist[i] / 1000).toFixed(2)));

    const chartDefaults = {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { display: false } },
      scales: {
        x: { type: 'linear', bounds: 'data', ticks: { maxTicksLimit: 7, font: { size: 10 }, color: '#8a8880' }, grid: { color: 'rgba(0,0,0,.05)' }, border: { color: 'rgba(0,0,0,.1)' } },
        y: { ticks: { font: { size: 10 }, color: '#8a8880' }, grid: { color: 'rgba(0,0,0,.05)' }, border: { color: 'rgba(0,0,0,.1)' } }
      }
    };

    state.elevCI = new Chart(canvas, {
      type: 'line',
      plugins: [wptMarkersPlugin],
      data: {
        datasets: [{
          data: spts.map((p, i) => ({ x: cds[i], y: Math.round(p.ele), kme: state.cumDistEffort[indices[i]] / 1000 })),
          fill: true,
          backgroundColor: 'rgba(61,241,90,0.08)',
          borderColor: '#087f01',
          borderWidth: 2,
          pointRadius: 0,
          tension: 0.35
        }]
      },
      options: {
        ...chartDefaults,
        layout: { padding: { left: 10, right: 10, top: 0, bottom: 0 } },
        plugins: {
          ...chartDefaults.plugins,
          wptMarkers: true,
          tooltip: { callbacks: { label: c => c.parsed.y + ' m alt.', title: c => c[0].raw.kme.toFixed(2) + ' kme' } }
        },
        scales: {
          ...chartDefaults.scales,
          x: { ...chartDefaults.scales.x, title: { display: true, text: 'Distance (km)', font: { size: 10 }, color: '#8a8880' } },
          y: { ...chartDefaults.scales.y, title: { display: true, text: 'Altitude (m)', font: { size: 10 }, color: '#8a8880' } }
        }
      }
    });
  }

  // ============================================================
  // Tableau waypoints
  // ============================================================
  function initTextarea(el) {
    if (!el || el.tagName !== 'TEXTAREA') return;
    const adjust = () => {
      el.style.height = 'auto';
      el.style.height = el.scrollHeight + 'px';
    };
    el.addEventListener('input', adjust);
    setTimeout(adjust, 0);
  }

  function renderWptTable() {
    const panel = $('#wpt-panel');
    const count = $('#wpt-count');
    const tbody = $('#wpt-tbody');
    const startBar = $('#start-time-bar');

    if (!state.wpts.length) {
      panel.style.display = 'block';
      count.textContent = '(0)';
      tbody.innerHTML = '';
      startBar.style.display = 'flex';
      return;
    }

    panel.style.display = 'block';
    count.textContent = '(' + state.wpts.length + ')';
    startBar.style.display = 'flex';

    const startInp = $('#startTimeInput');
    if (!startInp.dataset.userModified) {
      startInp.value = state.trackDate.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    }

    tbody.innerHTML = state.wpts.map((w, i) => {
      const mn = computeMN03(w.lat, w.lon);
      return `
      <tr data-lat="${w.lat}" data-lon="${w.lon}" data-index="${i}">
        <td><span class="wpt-num">${i + 1}</span></td>
        <td>
          <input type="text" class="wpt-name-input" id="wptNameInput${i}" data-index="${i}" value="${escapeHtml(w.name)}" placeholder="Nom du waypoint...">
          <textarea class="wpt-desc-input" id="descInput${i}" data-index="${i}" rows="1" placeholder="Description...">${escapeHtml(w.desc)}</textarea>
        </td>
        <td class="wpt-ele">${w.trkptEle !== null ? Math.round(w.trkptEle) + ' m' : (w.ele !== null ? Math.round(w.ele) + ' m' : '—')}</td>
        <td>
          <div class="wpt-ele">${mn.x} / ${mn.y}</div>
          <div class="wpt-coord">${w.lat.toFixed(5)}, ${w.lon.toFixed(5)}</div>
        </td>
        <td class="wpt-coord">${(w.distFromStart / 1000).toFixed(2)} km</td>
        <td class="wpt-coord">${(w.distEffortFromStart / 1000).toFixed(2)} kme</td>
        <td><span class="wpt-arrival interpolated">—</span></td>
        <td>
          <input type="number" class="wpt-break-input" data-index="${i}" value="${w.brkT}" min="0" step="1"
            style="font-family:var(--mono);font-size:13px;border:1px solid var(--border);border-radius:6px;padding:4px 10px;background:var(--surface);color:var(--text);outline:none;width:72px;">
        </td>
        <td><span class="wpt-departure interpolated">—</span></td>
        <td>
          <button class="wpt-delete-btn" data-index="${i}" title="Supprimer" style="border:1px solid var(--border);cursor:pointer;color:var(--muted);padding:4px 5px;font-size:0;line-height:1;display:inline-flex;align-items:center;justify-content:center;border-radius:6px;width:28px;height:28px;box-sizing:border-box;">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
        </td>
      </tr>`;
    }).join('');

    $$('.wpt-desc-input', tbody).forEach(initTextarea);
    updateWptTimes();
  }

  function updateWptTimes() {
    const speedVal = parseFloat($('#speedInput').value) || 4.6;
    const [hh, mm] = ($('#startTimeInput').value || '08:00').split(':').map(Number);
    const t0 = new Date();
    t0.setHours(hh, mm, 0, 0);

    let cumBreakTimeMin = 0;

    state.wpts.forEach((w, i) => {

      const row = $(`#wpt-tbody tr[data-index="${i}"]`);
      if (!row) return;
      const spanArr = row.querySelector('.wpt-arrival');
      if (!spanArr) return;
      const spanDep = row.querySelector('.wpt-departure');
      if (!spanDep) return;

      if (speedVal > 0) {
        const distKme = w.distEffortFromStart / 1000;
        const ms = (distKme / speedVal) * 3600000;
        const tArr = new Date(t0.getTime() + ms + cumBreakTimeMin * 60 * 1000);
        const tDep = new Date(t0.getTime() + ms + (cumBreakTimeMin + w.brkT) * 60 * 1000);
        spanArr.textContent = tArr.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
        spanArr.className = 'wpt-arrival';
        spanDep.textContent = tDep.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
        spanDep.className = 'wpt-departure';
      } else {
        spanArr.textContent = '—';
        spanArr.className = 'wpt-arrival interpolated';
        spanDep.textContent = '—';
        spanDep.className = 'wpt-departure interpolated';
      }
      cumBreakTimeMin += w.brkT;
    });
  }

  // ============================================================
  // PDF / Export
  // ============================================================
  window.downloadPdf = async function () {
    const original = $('#dashboard');
    let mapImgData = null;

    // 1. Capturer la carte du DOM réel en image PNG
    try {
      const mapEl = $('#map');
      if (mapEl && window.htmlToImage) {
        // Forcer un invalidateSize pour être sûr que tout est bien calé
        if (state.mapInst) state.mapInst.invalidateSize();
        await new Promise(r => setTimeout(r, 600));

        mapImgData = await htmlToImage.toPng(mapEl, {
          cacheBust: true,
          pixelRatio: 2,
          backgroundColor: null,
          skipFonts: true,
        });
      }
    } catch (capErr) {
      console.warn('Capturer carte échouée, fallback sur rendu direct :', capErr);
    }

    // 2. Cloner le dashboard
    const clone = original.cloneNode(true);

    // 3. Remplacer la carte par l'image capturée (si dispo)
    const mapClone = clone.querySelector('#map');
    if (mapClone && mapImgData) {
      mapClone.innerHTML = '';
      const img = document.createElement('img');
      img.src = mapImgData;
      img.style.cssText = 'width:100%;height:500px;display:block;object-fit:cover;';
      mapClone.appendChild(img);
    }

    // 4. Date formatée (depuis DOM original)
    const dateOriginal = $('#track-date');
    const dateClone = clone.querySelector('#track-date');
    if (dateClone && dateOriginal) {
      const div = document.createElement('div');
      div.className = dateClone.className;
      const d = new Date(dateOriginal.value);
      div.textContent = isNaN(d.getTime()) ? dateOriginal.value : d.toLocaleDateString('fr-FR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
      dateClone.parentNode.replaceChild(div, dateClone);
    }

    // 4b. Titre du tracé (input -> texte)
    const nameOriginal = $('#track-name');
    const nameClone = clone.querySelector('#track-name');
    if (nameClone && nameOriginal) {
      const div = document.createElement('div');
      div.id = nameClone.id;
      div.className = nameClone.className;
      div.textContent = nameOriginal.value || '';
      nameClone.parentNode.replaceChild(div, nameClone);
    }

    // 5. Textareas -> divs (valeurs lues depuis le DOM original)
    // Ne traiter que les <textarea> réels (évite d'écraser le div de date créé au §4)
    clone.querySelectorAll('.wpt-desc-input').forEach(el => {
      if (el.tagName !== 'TEXTAREA') return;
      let val = '';
      const origEl = el.id ? document.getElementById(el.id) : null;
      if (origEl) val = origEl.value || '';
      else val = el.value || '';
      const div = document.createElement('div');
      div.className = el.className;
      div.textContent = val;
      el.parentNode.replaceChild(div, el);
    });

    // 5a. Noms des waypoints (input -> texte)
    clone.querySelectorAll('.wpt-name-input').forEach(el => {
      if (el.tagName !== 'INPUT') return;
      let val = '';
      const origEl = el.id ? document.getElementById(el.id) : null;
      if (origEl) val = origEl.value || '';
      else val = el.value || '';
      const div = document.createElement('div');
      div.className = el.className;
      div.textContent = val;
      el.parentNode.replaceChild(div, el);
    });

    // 5b. Vitesse de marche (input -> texte, depuis DOM original)
    const speedOriginal = $('#speedInput');
    const speedClone = clone.querySelector('#speedInput');
    if (speedClone && speedOriginal) {
      const val = speedOriginal.value || '4.6';
      const span = document.createElement('span');
      span.style.cssText = 'font-family:var(--mono);font-size:13px;border:1px solid var(--border);border-radius:6px;padding:4px 10px;background:var(--surface);color:var(--text);display:inline-block;min-width:72px;';
      span.textContent = val;
      speedClone.parentNode.replaceChild(span, speedClone);
    }

    // 5c. Canvas Chart.js -> image (depuis DOM original)
    const origCanvas = $('#elevChart');
    const chartClone = clone.querySelector('#elevChart');
    if (origCanvas && chartClone && state.elevCI) {
      const img = document.createElement('img');
      img.src = origCanvas.toDataURL('image/png');
      img.style.cssText = 'width:100%;height:100%;display:block;';
      chartClone.parentNode.replaceChild(img, chartClone);
    }

    // 6. Masquer colonne coordonnées
    const table = clone.querySelector('#wpt-table');
    if (table) {
      table.querySelectorAll('tr > *:nth-child(4)').forEach(el => el.style.display = 'none');
    }

    // 7. Masquer boutons export/import/nouveau
    clone.querySelectorAll('#download_Btn, #new_Btn, #export_Btn').forEach(b => b.style.display = 'none');

    // 8. Container temporaire avec largeur fixe
    const temp = document.createElement('div');
    temp.style.cssText = 'position:absolute;left:-9999px;top:0;width:1140px;';
    temp.appendChild(clone);
    document.body.appendChild(temp);

    await new Promise(r => setTimeout(r, 400));

    try {
      await html2pdf().set({
        margin: 0,
        filename: (state.trackName || 'dispositif') + '_dispositif.pdf',
        image: { type: 'jpeg', quality: 0.98 },
        html2canvas: { scale: 2, useCORS: true },
        jsPDF: { unit: 'in', format: 'letter', orientation: 'portrait' }
      }).from(clone).save();
    } catch (err) {
      console.error('PDF Error:', err);
      showError('Erreur lors de la génération du PDF.');
    } finally {
      if (temp.parentNode) document.body.removeChild(temp);
    }
  };

  window.exportGpx = function() {
    const kmeh = parseFloat($('#speedInput').value) || 4.8;
    let gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Dispositif de marche ASG" xmlns="http://www.topografix.com/GPX/1/1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
  <metadata>
    <name>${escapeXml(state.trackName || 'Ma Randonnée')}</name>
    <time>${state.trackDate.toISOString()}</time>
    <author>${escapeXml(state.trackAuthor)}</author>
    <extensions>
      <asg><speed>${kmeh || '4.8'}</speed></asg>
    </extensions>
  </metadata>
  <trk>
    <name>${escapeXml(state.trackName || 'Ma Randonnée')}</name>
    <trkseg>
`;

    state.wpts.forEach(w => {
      gpx += `  <wpt lat="${w.lat}" lon="${w.lon}">\n`;
      if (w.name) gpx += `    <name>${escapeXml(w.name)}</name>\n`;
      if (w.desc) gpx += `    <desc>${escapeXml(w.desc)}</desc>\n`;
      if (w.cmt) gpx += `    <cmt>${escapeXml(w.cmt)}</cmt>\n`;
      if (w.ele !== null && !isNaN(w.ele)) gpx += `    <ele>${w.ele}</ele>\n`;
      if (w.brkT && w.brkT > 0) {
        gpx += `    <extensions>\n      <asg>\n        <breakTimeMin>${w.brkT}</breakTimeMin>\n      </asg>\n    </extensions>\n`;
      }
      gpx += `  </wpt>\n`;
    });

    state.pts.forEach(p => {
      gpx += `      <trkpt lat="${p.lat}" lon="${p.lon}">`;
      if (p.ele !== null && !isNaN(p.ele)) gpx += `<ele>${p.ele}</ele>`;
      gpx += `</trkpt>\n`;
    });

    gpx += `    </trkseg>\n  </trk>\n</gpx>`;

    const blob = new Blob([gpx], { type: 'application/gpx+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (state.trackName || 'export').replace(/[^a-z0-9]/gi, '_').toLowerCase() + '.gpx';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // ============================================================
  // Dessin de tracé manuel
  // ============================================================

  window.startNewTrack = function() {
    clearError();

    // Sauvegarder la vue actuelle de la carte avant reset
    let savedView = { center: [46.2044, 6.1432], zoom: 13 };
    if (state.mapInst) {
      const c = state.mapInst.getCenter();
      savedView = { center: [c.lat, c.lng], zoom: state.mapInst.getZoom() };
    }

    savePreviousState(); // mémorise le trek précédent
    resetApp();          // ménage complet

    state.isDrawingTrack = true;
    state.isRouting = false;
    state.ignoreMapClickUntil = Date.now() + 600;
    state.trackName = 'Nouveau tracé';
    $('#track-name').value = 'Nouveau tracé';

    showDashboard();
    $('#drawing-controls').style.display = 'flex';
    $('#drawingStatus').textContent = 'Cliquez sur la carte pour ajouter des points';

    createMap({ initialView: savedView });
  };

  async function fetchWorkerSegment(from, to) {
    console.log('%c[ROUTING] Tentative Worker ORS → ' + WORKER_URL, 'color:blue');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(WORKER_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lat1: from.lat, lon1: from.lon,
          lat2: to.lat, lon2: to.lon
        }),
        signal: controller.signal
      });
      clearTimeout(timeout);
      if (!res.ok) {
        const errText = await res.text();
        throw new Error('HTTP ' + res.status + ' — ' + errText.substring(0, 200));
      }
      const data = await res.json();
      const coords = data.features[0].geometry.coordinates; // [[lon, lat, ele], ...]
      if (coords.length < 2) throw new Error('Pas assez de points dans la réponse');
      const firstRouterEle = typeof coords[0][2] === 'number' ? coords[0][2] : 0;
      const lastRouterEle = typeof coords[coords.length - 1][2] === 'number' ? coords[coords.length - 1][2] : 0;
      const pts = coords.slice(1, -1).map(([lon, lat, ele]) => ({ lat, lon, ele: typeof ele === 'number' ? ele : 0 }));
      console.log('%c[ROUTING] ✔ Worker ORS répond OK (' + coords.length + ' points)', 'color:green');
      return { pts, firstRouterEle, lastRouterEle };
    } catch (err) {
      clearTimeout(timeout);
      console.error('%c[ROUTING] ✘ Worker ORS échoue :', 'color:red', err.message || err);
      throw err;
    }
  }

  async function fetchBRouterSegment(from, to, profile) {
    console.log('%c[ROUTING] Tentative BRouter → profile=' + profile, 'color:blue');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const url = `https://brouter.de/brouter?lonlats=${from.lon},${from.lat}|${to.lon},${to.lat}&profile=${profile}&format=geojson`;
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      if (!data.features || !data.features[0] || !data.features[0].geometry) throw new Error('Pas de géométrie');
      const coords = data.features[0].geometry.coordinates;
      if (coords.length < 2) throw new Error('Pas assez de points');
      const firstRouterEle = typeof coords[0][2] === 'number' ? coords[0][2] : 0;
      const lastRouterEle = typeof coords[coords.length - 1][2] === 'number' ? coords[coords.length - 1][2] : 0;
      const pts = coords.slice(1, -1).map(([lon, lat, ele]) => ({ lat, lon, ele: typeof ele === 'number' ? ele : 0 }));
      console.log('%c[ROUTING] ✔ BRouter OK profile=' + profile + ' (' + coords.length + ' points)', 'color:green');
      return { pts, firstRouterEle, lastRouterEle };
    } catch (err) {
      clearTimeout(timeout);
      console.error('%c[ROUTING] ✘ BRouter échoue profile=' + profile + ' :', 'color:orange', err.message || err);
      throw err;
    }
  }

  async function fetchRouteSegment(from, to) {
    const label = `[${from.lat.toFixed(4)},${from.lon.toFixed(4)}] → [${to.lat.toFixed(4)},${to.lon.toFixed(4)}]`;
    console.group('%c[ROUTING] Segment ' + label, 'color:#555;font-weight:bold');

    // 1. Essayer le Worker ORS
    if (WORKER_CONFIGURED) {
      try {
        const result = await fetchWorkerSegment(from, to);
        console.groupEnd();
        return result;
      } catch (err) {
        // déjà loggué dans fetchWorkerSegment
      }
    } else {
      console.warn('%c[ROUTING] Worker ignoré (non configuré)', 'color:orange');
    }

    // 2. Fallback cascade BRouter
    const profiles = ['foot', 'hiking-mountain', 'hiking', 'trekking'];
    for (const profile of profiles) {
      try {
        const result = await fetchBRouterSegment(from, to, profile);
        console.groupEnd();
        return result;
      } catch (err) {
        // déjà loggué dans fetchBRouterSegment
      }
    }

    console.warn('%c[ROUTING] Tous les routeurs ont échoué → segment droit utilisé', 'color:red;font-weight:bold');
    console.groupEnd();
    return { pts: [], firstRouterEle: 0, lastRouterEle: 0 };
  }

  async function addTrackPoint(lat, lon) {
    if (state.isRouting || Date.now() < state.ignoreMapClickUntil) return;
    if (state.pts.length === 0) {
      state.pts.push({ lat, lon, ele: 0, userPlaced: true });
      if (state.mapInst) state.mapInst.panTo([lat, lon]);
      drawTrackDuringEditing();
      return;
    }
    state.isRouting = true;
    $('#drawingStatus').textContent = 'Calcul de l\'itinéraire...';
    const lastPt = state.pts[state.pts.length - 1];
    const route = await fetchRouteSegment(lastPt, { lat, lon });

    // Si c'est le premier segment calculé, corrige l'altitude du point de départ
    // avec celle fournie par le routeur pour son origine.
    if (state.pts.length === 1 && typeof route.firstRouterEle === 'number') {
      state.pts[0].ele = route.firstRouterEle;
    }

    const prevDist = state.totalDist;
    const prevGain = state.gainPos;

    route.pts.forEach(p => state.pts.push(p));
    state.pts.push({ lat, lon, ele: typeof route.lastRouterEle === 'number' ? route.lastRouterEle : 0, userPlaced: true });
    state.isRouting = false;

    // Met à jour les stats en temps réel pendant le dessin
    if (state.pts.length >= 2) {
      computeTrackMetrics();
      renderStats();
      const segDist = ((state.totalDist - prevDist) / 1000).toFixed(2);
      const segDPlus = state.hasEle ? Math.round(state.gainPos - prevGain) + 'm+' : '';
      $('#drawingStatus').textContent = `Segment ajouté : +${segDist} km — ${segDPlus}`;
    } else {
      $('#drawingStatus').textContent = 'Cliquez sur la carte pour ajouter des points';
    }

    drawTrackDuringEditing();
  }

  window.undoLastPoint = function() {
    if (!state.isDrawingTrack || !state.pts.length || state.isRouting) return;
    state.pts.pop();
    while (state.pts.length && !state.pts[state.pts.length - 1].userPlaced) {
      state.pts.pop();
    }
    drawTrackDuringEditing();
    if (state.pts.length >= 2) {
      computeTrackMetrics();
      renderStats();
    }
    updateUIState();
  };

  window.cancelDrawing = function() {
    state.isDrawingTrack = false;
    $('#drawing-controls').style.display = 'none';

    if (previousState) {
      // Restaurer le trek précédent
      state.pts = previousState.pts.map(p => ({ ...p }));
      state.wpts = previousState.wpts.map(w => ({ ...w }));
      state.trackName = previousState.trackName;
      state.trackDate = new Date(previousState.trackDate);
      state.trackAuthor = previousState.trackAuthor;
      state.cumDist = [...previousState.cumDist];
      state.cumDistEffort = [...previousState.cumDistEffort];
      state.totalDist = previousState.totalDist;
      state.totalDistEffort = previousState.totalDistEffort;
      state.gainPos = previousState.gainPos;
      state.gainNeg = previousState.gainNeg;
      state.hasEle = previousState.hasEle;
      state.eles = [...previousState.eles];

      $('#track-name').value = state.trackName;
      $('#track-author').value = state.trackAuthor;
      $('#speedInput').value = previousState.speed;
      $('#startTimeInput').value = previousState.startTime;
      $('#track-date').value = previousState.trackDateValue;

      showDashboard();
      renderStats();
      renderWptTable();
      createMap({ initialView: previousState.mapView });
      createChart();
      updateUIState();
      previousState = null;
    } else {
      resetApp();
      createMap({ initialView: { center: [46.2044, 6.1432], zoom: 13 } });
    }
  };

  function drawTrackDuringEditing() {
    if (!state.mapInst) return;
    state.markerGroup.clearLayers();
    const lls = state.pts.map(p => [p.lat, p.lon]);
    if (lls.length >= 2) {
      state.markerGroup.addLayer(L.polyline(lls, { color: '#3d5af1', weight: 3.5, opacity: 0.9 }));
    }
    lls.forEach((ll, i) => {
      const pt = state.pts[i];
      if (!pt.userPlaced) return; // masquer les points intermédiaires OSRM
      const color = i === 0 ? '#1a9e6e' : (i === lls.length - 1 ? '#e05a2b' : '#3d5af1');
      state.markerGroup.addLayer(L.circleMarker(ll, {
        radius: 5, fillColor: color, color: '#fff', weight: 2, opacity: 1, fillOpacity: 0.9
      }));
    });
  }

  window.finishTrackDrawing = async function() {
    state.isDrawingTrack = false;
    if (state.pts.length < 2) {
      showError('Le tracé doit comporter au moins 2 points.');
      resetApp();
      return;
    }
    $('#undoDrawingBtn').style.display = 'none';
    $('#finishDrawingBtn').style.display = 'none';
    $('#drawingStatus').textContent = 'Finalisation...';

    // Le 1er point est posé manuellement à ele:0, tandis que les suivants
    // viennent du routeur (ORS/BRouter) avec des altitudes réelles.
    // On corrige donc localement le 1er point sans appel réseau.
    if (state.pts[0].ele === 0) {
      const firstWithEle = state.pts.find(p => p.ele !== 0);
      if (firstWithEle) {
        state.pts[0].ele = firstWithEle.ele;
        console.log('[ELEV] Altitude du 1er point corrigée :', firstWithEle.ele);
      }
    }

    $('#drawing-controls').style.display = 'none';
    $('#undoDrawingBtn').style.display = '';
    $('#finishDrawingBtn').style.display = '';

    computeTrackMetrics();
    renderStats();
    renderWptTable();
    createMap();
    createChart();
    updateUIState();
  };

  // ============================================================
  // Reset
  // ============================================================
  window.resetApp = function() {
    clearError();

    if (state.mapInst) { state.mapInst.remove(); state.mapInst = null; }
    if (state.elevCI) { state.elevCI.destroy(); state.elevCI = null; }

    state.pts = [];
    state.wpts = [];
    state.trackName = '';
    state.trackDate = new Date();
    state.trackAuthor = '';
    state.totalDist = 0;
    state.totalDistEffort = 0;
    state.gainPos = 0;
    state.gainNeg = 0;
    state.cumDist = [0];
    state.cumDistEffort = [0];
    state.eles = [];
    state.hasEle = false;
    state.isAddingMarker = false;
    state.isDrawingTrack = false;
    state.isRouting = false;

    $('#statsGrid').innerHTML = '';
    $('#wpt-tbody').innerHTML = '';
    $('#track-name').value = '';
    $('#track-author').value = '';
    $('#track-date').value = '';
    $('#startTimeInput').value = '08:00';
    delete $('#startTimeInput').dataset.userModified;
    $('#drawing-controls').style.display = 'none';

    // Nettoyer le hash de partage
    history.replaceState(null, '', window.location.pathname + window.location.search);
    updateUIState();
  };

  window.shareTrack = async function() {
    if (!supportsCompression()) {
      showError('La fonction de partage n\'est pas supportée par ce navigateur.');
      return;
    }
    try {
      const payload = {
        n: state.trackName,
        a: state.trackAuthor,
        d: state.trackDate.toISOString(),
        s: parseFloat($('#speedInput').value) || 4.6,
        p: simplifyPoints(state.pts).map(p => [+p.lat.toFixed(6), +p.lon.toFixed(6), +p.ele.toFixed(2)]),
        w: state.wpts.map(w => [
          +w.lat.toFixed(6), +w.lon.toFixed(6),
          w.name, w.desc || '', w.cmt || '',
          w.ele !== null ? +w.ele.toFixed(2) : null,
          w.brkT || 0
        ])
      };
      const json = JSON.stringify(payload);
      const compressed = await compressToBase64(json);
      const url = window.location.origin + window.location.pathname + window.location.search + '#t=' + compressed;

      await navigator.clipboard.writeText(url);

      const btn = $('#share_Btn');
      const original = btn.innerHTML;
      btn.innerHTML = '<span style="color:#1a9e6e">URL copiée !</span>';
      setTimeout(() => btn.innerHTML = original, 2000);
    } catch (err) {
      console.error('Share error:', err);
      showError('Erreur lors de la génération du lien de partage.');
    }
  };

  async function loadFromHash() {
    const hash = location.hash;
    if (!hash || !hash.startsWith('#t=')) return;
    if (!supportsCompression()) {
      showError('Impossible d\'ouvrir le lien de partage avec ce navigateur.');
      return;
    }
    try {
      const compressed = hash.slice(3);
      const json = await decompressFromBase64(compressed);
      const data = JSON.parse(json);

      state.trackName = data.n || '';
      state.trackAuthor = data.a || '';
      state.trackDate = data.d ? new Date(data.d) : new Date();
      if (!isNaN(data.s)) $('#speedInput').value = data.s;

      state.pts = (data.p || []).map(([lat, lon, ele]) => ({ lat, lon, ele: ele != null ? ele : 0 }));
      state.wpts = (data.w || []).map(([lat, lon, name, desc, cmt, ele, brkT]) => ({
        lat, lon,
        name: name || '', desc: desc || '', cmt: cmt || '',
        ele: ele !== null ? ele : null,
        brkT: brkT || 0
      }));

      if (!state.pts.length) throw new Error('Aucun point de trace dans le lien.');

      showDashboard();
      computeTrackMetrics();
      snapWaypointsToTrack();
      renderStats();
      renderWptTable();
      createMap();
      createChart();
      updateUIState();
    } catch (err) {
      console.error('Load from hash error:', err);
      showError('Erreur lors de l\'ouverture du lien de partage : ' + err.message);
    }
  }

  // ============================================================
  // Process fichier
  // ============================================================
  function processFile(file) {
    clearError();
    if (!file.name.toLowerCase().endsWith('.gpx') && file.type && !file.type.includes('xml')) {
      showError('Veuillez sélectionner un fichier .gpx valide.');
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => showError('Impossible de lire ce fichier.');
    reader.onload = e => {
      try {
        // Sortir du mode dessin si actif
        state.isDrawingTrack = false;
        const dc = $('#drawing-controls');
        if (dc) dc.style.display = 'none';

        parseGPX(e.target.result, file.name);
        showDashboard();
        computeTrackMetrics();
        snapWaypointsToTrack();
        renderStats();
        renderWptTable();
        createMap();
        createChart();
        updateUIState();
        // Nettoyer le hash de partage lors du chargement d'un nouveau fichier
        history.replaceState(null, '', window.location.pathname + window.location.search);
      } catch (err) {
        showError('Erreur lors de l\'analyse : ' + err.message);
        console.error(err);
      }
    };
    reader.readAsText(file);
  }

  // ============================================================
  // Debug
  // ============================================================
  async function debugWithLocalFile() {
    try {
      const response = await fetch('itineraire-demo.gpx');
      if (!response.ok) throw new Error('Fichier de debug introuvable');
      const blob = await response.blob();
      const file = new File([blob], 'itineraire-demo.gpx', { type: 'application/gpx+xml' });
      console.log('🚀 Chargement du fichier local itineraire-demo.gpx...');
      processFile(file);
    } catch (e) {
      console.error('Erreur debug:', e);
    }
  }

  // ============================================================
  // Initialisation (listeners uniques)
  // ============================================================
  function init() {
    // Upload (drop zone optionnelle si elle existe encore)
    const dropZone = $('#dropZone');
    if (dropZone) {
      dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
      dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
      dropZone.addEventListener('drop', e => {
        e.preventDefault();
        dropZone.classList.remove('drag-over');
        const f = e.dataTransfer.files[0];
        if (f) processFile(f);
      });
    }
    $('#fileInput').addEventListener('change', e => { if (e.target.files[0]) processFile(e.target.files[0]); });

    // Afficher le dashboard directement
    $('#dashboard').style.display = 'block';

    // État propre au chargement
    clearError();
    state.pts = [];
    state.wpts = [];
    state.trackName = '';
    state.trackDate = new Date();
    state.trackAuthor = '';
    state.totalDist = 0;
    state.totalDistEffort = 0;
    state.gainPos = 0;
    state.gainNeg = 0;
    state.cumDist = [0];
    state.cumDistEffort = [0];
    state.eles = [];
    state.hasEle = false;
    state.isAddingMarker = false;
    state.isDrawingTrack = false;
    state.isRouting = false;

    $('#track-name').value = '';
    $('#track-author').value = '';
    $('#track-date').value = new Date().toISOString().slice(0, 10);
    $('#speedInput').value = '4.6';
    $('#startTimeInput').value = '08:00';
    delete $('#startTimeInput').dataset.userModified;

    // Init carte sur Genève
    createMap({ initialView: { center: [46.2044, 6.1432], zoom: 13 } });

    // Tableau waypoints vide (visible)
    renderWptTable();

    // Stats vierges
    renderStats();
    updateUIState();

    // Drag-and-drop global sur toute la page
    document.addEventListener('dragover', e => { e.preventDefault(); });
    document.addEventListener('drop', e => {
      e.preventDefault();
      const f = e.dataTransfer.files[0];
      if (f) processFile(f);
    });

    // Contrôles globaux
    $('#speedInput').addEventListener('input', () => { renderStats(); updateWptTimes(); });
    $('#startTimeInput').addEventListener('input', function() {
      this.dataset.userModified = 'true';
      const [hh, mm] = this.value.split(':').map(Number);
      state.trackDate.setHours(hh, mm, 0, 0);
      updateWptTimes();
    });
    $('#track-author').addEventListener('input', function() { state.trackAuthor = this.value; });
    $('#track-name').addEventListener('input', function() { state.trackName = this.value; });
    $('#track-date').addEventListener('change', function() {
      const [y, m, d] = this.value.split('-').map(Number);
      state.trackDate.setFullYear(y, m - 1, d);
    });

    // Tableau waypoints — délégation d'événements (pas de fuite)
    const tbody = $('#wpt-tbody');
    tbody.addEventListener('click', e => {
      if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON' || e.target.closest('.wpt-delete-btn')) return;
      const row = e.target.closest('tr[data-lat]');
      if (!row || !state.mapInst) return;
      state.mapInst.setView([parseFloat(row.dataset.lat), parseFloat(row.dataset.lon)], 15);
    });

    tbody.addEventListener('input', e => {
      const idx = parseInt(e.target.dataset.index, 10);
      if (isNaN(idx)) return;
      if (e.target.classList.contains('wpt-name-input')) {
        state.wpts[idx].name = e.target.value;
        drawMarkers(false);
      } else if (e.target.classList.contains('wpt-desc-input')) {
        state.wpts[idx].desc = e.target.value;
        drawMarkers(false);
      } else if (e.target.classList.contains('wpt-break-input')) {
        state.wpts[idx].brkT = parseFloat(e.target.value) || 0;
        updateWptTimes();
      }
    });

    // Suppression d'un waypoint
    tbody.addEventListener('click', e => {
      const btn = e.target.closest('.wpt-delete-btn');
      if (!btn) return;
      const idx = parseInt(btn.dataset.index, 10);
      if (isNaN(idx)) return;
      state.wpts.splice(idx, 1);
      renderWptTable();
      drawMarkers(false);
      createChart();
    });

    // Clic sur le profil altimétrique -> scroll vers le waypoint dans le tableau
    $('#elevChart').addEventListener('click', e => {
      if (!state.elevCI) return;
      const rect = e.target.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const clickY = e.clientY - rect.top;
      const { scales: { x, y } } = state.elevCI;

      let closest = null, closestDist = Infinity;
      state.wpts.forEach((w, i) => {
        const distKm = w.distFromStart / 1000;
        const ele = w.trkptEle !== null ? w.trkptEle : (w.ele !== null ? w.ele : 0);
        const px = x.getPixelForValue(distKm);
        const py = y.getPixelForValue(ele);
        if (px === null || py === null || isNaN(px) || isNaN(py)) return;
        const dx = clickX - px;
        const dy = clickY - py;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < 16 && d < closestDist) {
          closestDist = d;
          closest = i;
        }
      });

      if (closest !== null) {
        const row = $(`#wpt-tbody tr[data-index="${closest}"]`);
        if (row) {
          row.scrollIntoView({ behavior: 'smooth', block: 'center' });
          $$('#wpt-tbody tr.highlight').forEach(r => r.classList.remove('highlight'));
          row.classList.add('highlight');
          setTimeout(() => row.classList.remove('highlight'), 1800);
        }
        if (state.mapInst) state.mapInst.setView([state.wpts[closest].lat, state.wpts[closest].lon], 15);
      }
    });

    $('#btn-add-marker').addEventListener('click', toggleAddMarker);

    // Chargement depuis hash de partage
    const hasTrackHash = location.hash && location.hash.startsWith('#t=');
    if (hasTrackHash) {
      loadFromHash();
    }

    // Debug (uniquement si aucun hash de partage présent)
    if (!hasTrackHash && new URLSearchParams(location.search).get('debug') === 'true') {
      console.warn('⚠️ MODE DEBUG ACTIF : Chargement du fichier de test...');
      debugWithLocalFile();
    }
  }

  init();
})();
