/* Capture Planner UI: map, inputs, live outputs, exports. Maths live in planner.js. */
(function () {
  'use strict';
  var P = window.Planner;
  var $ = function (id) { return document.getElementById(id); };

  /* ---------- theme (same behaviour as the site root) ---------- */
  (function () {
    var root = document.documentElement, btn = $('theme');
    function systemDark() { return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches; }
    function isDark() { var t = root.getAttribute('data-theme'); return t ? t === 'dark' : systemDark(); }
    function paint() { btn.textContent = isDark() ? 'Light' : 'Dark'; }
    var saved = null;
    try { saved = localStorage.getItem('theme'); } catch (e) {}
    if (saved === 'dark' || saved === 'light') root.setAttribute('data-theme', saved);
    paint();
    btn.addEventListener('click', function () {
      var next = isDark() ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      try { localStorage.setItem('theme', next); } catch (e) {}
      paint();
    });
  })();

  /* ---------- state ---------- */
  var state = {
    poly: [],            // [{lat,lon}]
    poi: null,           // {lat,lon}
    mode: 'idle',        // idle | draw | poi
    cam: null,           // working camera object (copy of preset, possibly edited)
    plan: null,
    tiers: [{ alt: 25, pitch: -30 }, { alt: 45, pitch: -45 }, { alt: 75, pitch: -62 }]
  };

  function saveState() {
    try {
      localStorage.setItem('capture-planner', JSON.stringify({
        poly: state.poly, poi: state.poi, tiers: state.tiers,
        view: { c: map.getCenter(), z: map.getZoom() }
      }));
    } catch (e) {}
  }
  function loadState() {
    try { return JSON.parse(localStorage.getItem('capture-planner') || 'null'); } catch (e) { return null; }
  }

  /* ---------- map ---------- */
  var saved = loadState();
  var map = L.map('map', { preferCanvas: true, zoomControl: true })
    .setView(saved && saved.view ? [saved.view.c.lat, saved.view.c.lng] : [42.4715, -86.0925], saved && saved.view ? saved.view.z : 15);
  var usgs = L.tileLayer('https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19, attribution: 'Imagery &copy; <a href="https://www.usgs.gov/">USGS</a> The National Map'
  });
  var osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  });
  usgs.addTo(map);
  L.control.layers({ 'USGS imagery': usgs, 'OpenStreetMap': osm }, null, { position: 'topleft' }).addTo(map);
  L.control.scale({ imperial: true }).addTo(map);
  // Fallback: if USGS tiles keep failing (offline, outage, outside US coverage), switch to OSM once.
  var tileErrors = 0, tileOk = 0, switched = false;
  usgs.on('tileload', function () { tileOk++; });
  usgs.on('tileerror', function () {
    tileErrors++;
    if (!switched && tileErrors >= 6 && tileOk === 0) {
      switched = true; map.removeLayer(usgs); osm.addTo(map); setStatus('USGS tiles unavailable here; switched to OpenStreetMap.');
    }
  });

  var canvas = L.canvas({ padding: 0.3 });
  var layers = {
    poly: L.polygon([], { color: getCSS('--area'), weight: 2, fillOpacity: 0.08 }).addTo(map),
    route: L.polyline([], { color: getCSS('--route'), weight: 1.6, opacity: 0.9, renderer: canvas }).addTo(map),
    photos: L.layerGroup().addTo(map),
    rings: L.layerGroup().addTo(map),
    vertices: L.layerGroup().addTo(map),
    poi: null
  };
  function getCSS(v) { return getComputedStyle(document.documentElement).getPropertyValue(v).trim() || '#7a4a2b'; }
  function restyle() {
    layers.poly.setStyle({ color: getCSS('--area') });
    layers.route.setStyle({ color: getCSS('--route') });
    recompute();
  }
  $('theme').addEventListener('click', function () { setTimeout(restyle, 0); });
  if (window.matchMedia) window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () { setTimeout(restyle, 0); });

  function setStatus(t) { $('status').textContent = t || ''; }

  /* ---------- polygon editing ---------- */
  var vtxIcon = L.divIcon({ className: 'vtx', iconSize: [12, 12] });
  var poiIcon = L.divIcon({ className: 'poi', iconSize: [14, 14] });

  function redrawPolygon() {
    layers.poly.setLatLngs(state.poly.map(function (p) { return [p.lat, p.lon]; }));
    layers.vertices.clearLayers();
    state.poly.forEach(function (p, i) {
      var m = L.marker([p.lat, p.lon], { icon: vtxIcon, draggable: true, keyboard: false });
      m.on('drag', function (e) { var ll = e.target.getLatLng(); state.poly[i] = { lat: ll.lat, lon: ll.lng }; layers.poly.setLatLngs(state.poly.map(function (q) { return [q.lat, q.lon]; })); });
      m.on('dragend', function () { recompute(); saveState(); });
      m.on('contextmenu', function (e) { L.DomEvent.stop(e); state.poly.splice(i, 1); redrawPolygon(); recompute(); saveState(); });
      m.on('dblclick', function (e) { L.DomEvent.stop(e); if (state.mode === 'draw') finishDraw(); });
      layers.vertices.addLayer(m);
    });
    $('finishBtn').disabled = !(state.mode === 'draw' && state.poly.length >= 3);
  }
  function setPolygon(pts) { state.poly = pts.slice(); redrawPolygon(); recompute(); saveState(); }
  function redrawPOI() {
    if (layers.poi) { map.removeLayer(layers.poi); layers.poi = null; }
    if (!state.poi) return;
    layers.poi = L.marker([state.poi.lat, state.poi.lon], { icon: poiIcon, draggable: true, title: 'Point of interest' }).addTo(map);
    layers.poi.on('drag', function (e) { var ll = e.target.getLatLng(); state.poi = { lat: ll.lat, lon: ll.lng }; });
    layers.poi.on('dragend', function () { recompute(); saveState(); });
  }

  function startDraw() {
    state.mode = 'draw'; state.poly = []; redrawPolygon();
    map.doubleClickZoom.disable();
    $('drawBtn').classList.add('on'); $('poiBtn').classList.remove('on');
    $('map').style.cursor = 'crosshair';
    setStatus('Click to add vertices. Finish or double-click to close.');
    recompute();
  }
  function finishDraw() {
    state.mode = 'idle';
    map.doubleClickZoom.enable();
    $('drawBtn').classList.remove('on'); $('map').style.cursor = '';
    if (state.poly.length < 3) { state.poly = []; setStatus('Need at least 3 vertices.'); }
    else setStatus(state.poly.length + ' vertices. Drag to adjust, right-click to remove.');
    redrawPolygon(); recompute(); saveState();
  }
  function startPOI() {
    if (state.mode === 'draw') finishDraw();
    state.mode = 'poi'; $('poiBtn').classList.add('on'); $('map').style.cursor = 'crosshair';
    setStatus('Click the map to place the point of interest.');
  }

  map.on('click', function (e) {
    if (state.mode === 'draw') {
      state.poly.push({ lat: e.latlng.lat, lon: e.latlng.lng });
      redrawPolygon(); recompute();
    } else if (state.mode === 'poi') {
      state.poi = { lat: e.latlng.lat, lon: e.latlng.lng };
      state.mode = 'idle'; $('poiBtn').classList.remove('on'); $('map').style.cursor = '';
      redrawPOI(); setStatus('POI set. Drag the marker to move it.');
      if (missionType() !== 'ring') { setMission('ring'); }
      recompute(); saveState();
    }
  });
  map.on('dblclick', function () { if (state.mode === 'draw') finishDraw(); });
  map.on('moveend', saveState);

  $('drawBtn').addEventListener('click', function () { state.mode === 'draw' ? finishDraw() : startDraw(); });
  $('finishBtn').addEventListener('click', finishDraw);
  $('poiBtn').addEventListener('click', startPOI);
  $('clearBtn').addEventListener('click', function () {
    if (state.mode === 'draw') finishDraw();
    state.poly = []; state.poi = null; redrawPolygon(); redrawPOI(); setStatus('Cleared.'); recompute(); saveState();
  });
  $('fitBtn').addEventListener('click', fit);
  function fit() {
    var b = null;
    if (state.poly.length >= 2) b = layers.poly.getBounds();
    if (layers.route.getLatLngs().length) b = b ? b.extend(layers.route.getBounds()) : layers.route.getBounds();
    if (!b && state.poi) b = L.latLngBounds([[state.poi.lat, state.poi.lon], [state.poi.lat, state.poi.lon]]).pad(0.002);
    if (b && b.isValid()) map.fitBounds(b.pad(0.15));
  }

  /* ---------- import ---------- */
  $('fileIn').addEventListener('change', function (e) {
    var f = e.target.files[0]; if (!f) return;
    var name = f.name.toLowerCase();
    var done = function (text) {
      try {
        var pts = P.parsePolygonText(text);
        if (state.mode === 'draw') finishDraw();
        setPolygon(pts); setStatus('Imported ' + f.name + ' (' + pts.length + ' vertices).'); fit();
      } catch (err) { setStatus('Import failed: ' + err.message); }
    };
    if (name.endsWith('.kmz')) {
      f.arrayBuffer().then(function (buf) { return JSZip.loadAsync(buf); }).then(function (zip) {
        var kml = Object.keys(zip.files).filter(function (n) { return n.toLowerCase().endsWith('.kml'); })[0];
        if (!kml) throw new Error('No .kml inside KMZ');
        return zip.file(kml).async('string');
      }).then(done).catch(function (err) { setStatus('Import failed: ' + err.message); });
    } else {
      f.text().then(done);
    }
    e.target.value = '';
  });

  /* ---------- camera ---------- */
  var camSel = $('camera');
  P.CAMERAS.forEach(function (c) { var o = document.createElement('option'); o.value = c.id; o.textContent = c.name; camSel.appendChild(o); });
  var camFields = ['sensorW', 'sensorH', 'focal', 'pxW', 'pxH'];
  function applyCamera(id, keepFields) {
    var preset = P.cameraById(id) || P.CAMERAS[0];
    state.cam = JSON.parse(JSON.stringify(preset));
    if (!keepFields) { camFields.forEach(function (k) { $(k).value = preset[k]; }); $('minInterval').value = preset.minInterval; }
    camSel.value = id;
    $('camNote').textContent = preset.note + (preset.wpml ? '' : ' Not a WPML aircraft; the KMZ export is for reference only.');
    $('camNote').className = 'hint' + (preset.verify ? ' verify' : '');
    readCamFields();
  }
  function readCamFields() {
    camFields.forEach(function (k) { var v = parseFloat($(k).value); if (isFinite(v) && v > 0) state.cam[k] = v; });
    var mi = parseFloat($('minInterval').value); if (isFinite(mi) && mi > 0) state.cam.minInterval = mi;
    var f = P.fov(state.cam);
    $('fovLine').textContent = 'FOV ' + f.h.toFixed(1) + '° × ' + f.v.toFixed(1) + '°, ' +
      (state.cam.pxW * state.cam.pxH / 1e6).toFixed(1) + ' MP, pixel pitch ' + (state.cam.sensorW / state.cam.pxW * 1000).toFixed(2) + ' µm, ' +
      state.cam.shutter + ' shutter, ' + state.cam.minInterval + ' s minimum interval.';
  }
  camSel.addEventListener('change', function () { applyCamera(camSel.value); syncDrive(); recompute(); });
  camFields.forEach(function (k) {
    $(k).addEventListener('input', function () {
      var preset = P.cameraById(camSel.value);
      if (preset && preset.id !== 'custom' && Math.abs(parseFloat($(k).value) - preset[k]) > 1e-9) {
        state.cam.id = 'custom'; camSel.value = 'custom'; $('camNote').textContent = 'Custom values (started from ' + preset.name + ').'; $('camNote').className = 'hint';
      }
      readCamFields(); syncDrive(); recompute();
    });
  });
  $('minInterval').addEventListener('input', function () { readCamFields(); recompute(); });

  /* ---------- mission type and drive mode ---------- */
  var hints = {
    nadir: 'Parallel lines, camera straight down. The standard for orthomosaics and DSMs.',
    double: 'Two nadir grids at 90°. Stronger geometry for photogrammetry of structures and for terrain models; twice the photos.',
    ring: 'Oblique orbits at several altitude tiers around a point of interest. What a Gaussian splat of a tree, tower or building actually needs. Set the POI on the map.'
  };
  function missionType() { return document.querySelector('input[name=mission]:checked').value; }
  function setMission(v) { document.querySelector('input[name=mission][value=' + v + ']').checked = true; onMissionChange(); }
  function onMissionChange() {
    var t = missionType();
    $('missionHint').textContent = hints[t];
    $('gridInputs').hidden = t === 'ring';
    $('ringInputs').hidden = t !== 'ring';
    $('wpmlModeRow').hidden = t === 'ring';
    if (t === 'ring' && !state.poi) setStatus('Use "Set POI" and click the map to place the point of interest.');
    recompute();
  }
  Array.prototype.forEach.call(document.querySelectorAll('input[name=mission]'), function (r) { r.addEventListener('change', onMissionChange); });

  function driveMode() { return document.querySelector('input[name=drive]:checked').value; }
  function syncDrive() {
    var byGsd = driveMode() === 'gsd';
    $('gsd').disabled = !byGsd; $('alt').disabled = byGsd;
    if (byGsd) {
      var g = parseFloat($('gsd').value); if (isFinite(g) && g > 0) $('alt').value = P.altitudeFromGsd(state.cam, g).toFixed(1);
    } else {
      var a = parseFloat($('alt').value); if (isFinite(a) && a > 0) $('gsd').value = P.gsdFromAltitude(state.cam, a).toFixed(2);
    }
  }
  Array.prototype.forEach.call(document.querySelectorAll('input[name=drive]'), function (r) { r.addEventListener('change', function () { syncDrive(); recompute(); }); });
  ['gsd', 'alt', 'front', 'side', 'speed', 'heading', 'poiH', 'ringOverlap', 'ringSpeed', 'minPhotos', 'usable', 'turnTime', 'dwell'].forEach(function (id) {
    $(id).addEventListener('input', function () { syncDrive(); recompute(); });
  });
  $('alignBtn').addEventListener('click', function () {
    if (state.poly.length < 3) { setStatus('Draw or import an area first.'); return; }
    var frame = P.frameForPolygon(state.poly);
    var xy = state.poly.map(function (p) { return frame.toXY(p.lat, p.lon); });
    $('heading').value = Math.round(P.longestEdgeHeading(xy));
    recompute();
  });

  /* ---------- tiers table ---------- */
  function renderTiers() {
    var tb = $('tierTable').querySelector('tbody'); tb.innerHTML = '';
    state.tiers.forEach(function (t, i) {
      var tr = document.createElement('tr');
      tr.innerHTML = '<td>' + (i + 1) + '</td>' +
        '<td><input type="number" step="1" min="2" data-i="' + i + '" data-k="alt" value="' + t.alt + '" aria-label="Tier ' + (i + 1) + ' altitude"></td>' +
        '<td><input type="number" step="1" min="-89" max="-1" data-i="' + i + '" data-k="pitch" value="' + t.pitch + '" aria-label="Tier ' + (i + 1) + ' pitch"></td>' +
        '<td><button type="button" class="x" data-i="' + i + '" aria-label="Remove tier">×</button></td>';
      tb.appendChild(tr);
    });
    Array.prototype.forEach.call(tb.querySelectorAll('input'), function (inp) {
      inp.addEventListener('input', function () {
        var v = parseFloat(inp.value); if (!isFinite(v)) return;
        state.tiers[+inp.dataset.i][inp.dataset.k] = v; recompute(); saveState();
      });
    });
    Array.prototype.forEach.call(tb.querySelectorAll('button.x'), function (b) {
      b.addEventListener('click', function () { if (state.tiers.length > 1) { state.tiers.splice(+b.dataset.i, 1); renderTiers(); recompute(); saveState(); } });
    });
  }
  $('addTier').addEventListener('click', function () {
    var last = state.tiers[state.tiers.length - 1] || { alt: 25, pitch: -30 };
    state.tiers.push({ alt: Math.round(last.alt * 1.4), pitch: Math.max(-80, last.pitch - 12) });
    renderTiers(); recompute(); saveState();
  });
  $('resetTiers').addEventListener('click', function () {
    state.tiers = [{ alt: 25, pitch: -30 }, { alt: 45, pitch: -45 }, { alt: 75, pitch: -62 }];
    renderTiers(); recompute(); saveState();
  });

  /* ---------- compute and render ---------- */
  function num(id, fallback) { var v = parseFloat($(id).value); return isFinite(v) ? v : fallback; }
  function fmt(v, d) { return isFinite(v) ? v.toLocaleString(undefined, { maximumFractionDigits: d == null ? 1 : d, minimumFractionDigits: d == null ? 0 : d }) : '–'; }
  function mins(s) { var m = Math.floor(s / 60), r = Math.round(s % 60); return m + ' min ' + (r < 10 ? '0' : '') + r + ' s'; }

  function recompute() {
    var t = missionType();
    var cam = state.cam;
    var plan = null;
    layers.photos.clearLayers(); layers.rings.clearLayers(); layers.route.setLatLngs([]);
    var usable = num('usable', 22);

    if (t === 'ring') {
      if (state.poi) {
        plan = P.planRing(state.poi, cam, {
          tiers: state.tiers, poiHeight: num('poiH', 0), frontOverlap: num('ringOverlap', 80) / 100,
          speed: Math.max(0.1, num('ringSpeed', 3)), minPhotos: num('minPhotos', 24), maxStepDeg: 15,
          dwellTime: num('dwell', 2), usableBatteryMin: usable
        });
      }
    } else if (state.poly.length >= 3) {
      var alt = num('alt', 100);
      if (alt > 0) {
        plan = P.planGrid(state.poly, cam, {
          altitude: alt, frontOverlap: num('front', 75) / 100, sideOverlap: num('side', 65) / 100,
          heading: num('heading', 0), speed: Math.max(0.1, num('speed', 8)), doubleGrid: t === 'double',
          turnTime: num('turnTime', 6), usableBatteryMin: usable
        });
      }
    }
    state.plan = plan;
    renderPlan(plan, t);
    var canExport = !!plan && plan.photos.length > 0;
    $('exportKML').disabled = !canExport; $('exportWPML').disabled = !canExport; $('exportCSV').disabled = !canExport;
  }

  function renderPlan(plan, t) {
    var stats = $('stats'), warns = $('warnings'), tierOut = $('tierOut');
    stats.innerHTML = ''; warns.innerHTML = ''; tierOut.innerHTML = ''; $('okline').hidden = true;
    function stat(k, v, s) {
      var d = document.createElement('div'); d.className = 'stat';
      d.innerHTML = '<div class="k">' + k + '</div><div class="v">' + v + '</div>' + (s ? '<div class="s">' + s + '</div>' : '');
      stats.appendChild(d);
    }
    if (!plan) {
      stat(t === 'ring' ? 'Point of interest' : 'Area', '–', t === 'ring' ? 'Set a POI on the map to plan the rings.' : 'Draw or import an area to see the plan.');
      // still show the camera-only numbers so the GSD/altitude relation is visible
      var alt0 = num('alt', 100), fp0 = P.footprint(state.cam, alt0);
      if (t !== 'ring') {
        stat('GSD at ' + fmt(alt0, 0) + ' m', fmt(P.gsdFromAltitude(state.cam, alt0), 2) + ' cm/px', (alt0 * P.FT_PER_M).toFixed(0) + ' ft AGL');
        stat('Image footprint', fmt(fp0.w, 0) + ' × ' + fmt(fp0.h, 0) + ' m');
        stat('Line spacing', fmt(P.lineSpacing(fp0.w, num('side', 65) / 100), 1) + ' m');
        stat('Photo interval', fmt(P.photoInterval(fp0.h, num('front', 75) / 100), 1) + ' m', fmt(P.photoInterval(fp0.h, num('front', 75) / 100) / Math.max(0.1, num('speed', 8)), 2) + ' s at ' + fmt(num('speed', 8), 1) + ' m/s');
        if (alt0 > P.PART107_LIMIT_M) warns.innerHTML = '<div class="warn error">Altitude ' + fmt(alt0, 0) + ' m (' + (alt0 * P.FT_PER_M).toFixed(0) + ' ft) exceeds the Part 107 ceiling of 400 ft AGL.</div>';
      }
      return;
    }

    // Draw on the map
    var routeLL = plan.waypoints.map(function (w) { return [w.lat, w.lon]; });
    layers.route.setLatLngs(routeLL);
    var photoColor = getCSS('--photo');
    var many = plan.photos.length > 1200;
    plan.photos.forEach(function (ph) {
      var c = L.circleMarker([ph.lat, ph.lon], { radius: many ? 1.2 : 2, color: photoColor, weight: 1, opacity: 0.8, fillOpacity: 0.6, renderer: canvas });
      if (!many) c.bindTooltip('#' + (ph.index + 1) + ' · ' + ph.alt.toFixed(0) + ' m · hdg ' + ph.heading.toFixed(0) + '° · pitch ' + ph.pitch.toFixed(0) + '°', { direction: 'top', opacity: 0.9 });
      layers.photos.addLayer(c);
    });
    if (plan.type === 'ring') {
      plan.tiers.forEach(function (tier) {
        if (tier.invalid) return;
        layers.rings.addLayer(L.circle([plan.poi.lat, plan.poi.lon], { radius: tier.radius, color: getCSS('--route'), weight: 1, dashArray: '4 4', fill: false, renderer: canvas }));
      });
    }

    // Stats
    var ft = (plan.altitude * P.FT_PER_M).toFixed(0);
    if (plan.type === 'ring') {
      stat('Tiers', plan.tiers.length, 'top tier ' + fmt(plan.altitude, 0) + ' m / ' + ft + ' ft AGL');
      stat('Photos', plan.photos.length, 'one waypoint each, facing the POI');
      stat('Coarsest GSD', fmt(plan.gsd, 2) + ' cm/px', 'at frame centre on the top tier');
      stat('Closest spacing', fmt(plan.interval, 1) + ' m', fmt(plan.intervalS, 2) + ' s at ' + fmt(plan.speed, 1) + ' m/s');
      stat('Route length', fmt(plan.routeLen / 1000, 2) + ' km');
      stat('Flight time', mins(plan.timeS), 'incl. ' + fmt(num('dwell', 2), 1) + ' s dwell per photo');
      stat('Batteries', plan.batteries, 'at ' + fmt(num('usable', 22), 0) + ' usable min each');
      stat('Max speed for shutter', fmt(plan.maxSpeed, 1) + ' m/s', state.cam.minInterval + ' s minimum interval');
      var rows = plan.tiers.map(function (tr) {
        return '<tr><td>Tier ' + tr.index + '</td><td>' + fmt(tr.alt, 0) + '</td><td>' + fmt(tr.pitch, 0) + '°</td><td>' + (tr.invalid ? '–' : fmt(tr.radius, 0)) + '</td><td>' +
          (tr.invalid ? '–' : fmt(tr.slant, 0)) + '</td><td>' + (tr.invalid ? '–' : fmt(tr.gsd, 2)) + '</td><td>' + (tr.invalid ? '–' : tr.n) + '</td><td>' + (tr.invalid ? '–' : fmt(tr.stepDeg, 1) + '°') + '</td></tr>';
      }).join('');
      tierOut.innerHTML = '<table class="tierout"><thead><tr><th>Tier</th><th>Alt m</th><th>Pitch</th><th>Radius m</th><th>Slant m</th><th>GSD cm/px</th><th>Photos</th><th>Step</th></tr></thead><tbody>' + rows + '</tbody></table>';
    } else {
      var ha = plan.areaM2 / 1e4;
      stat('Area', fmt(ha, 2) + ' ha', fmt(plan.areaM2 / 4046.86, 2) + ' acres');
      stat('Altitude', fmt(plan.altitude, 0) + ' m AGL', ft + ' ft');
      stat('GSD', fmt(plan.gsd, 2) + ' cm/px');
      stat('Image footprint', fmt(plan.footprint.w, 0) + ' × ' + fmt(plan.footprint.h, 0) + ' m');
      stat('Line spacing', fmt(plan.spacing, 1) + ' m', plan.lineCount + (plan.type === 'double' ? ' lines, two passes' : ' lines'));
      stat('Photo interval', fmt(plan.interval, 1) + ' m', fmt(plan.intervalS, 2) + ' s at ' + fmt(plan.speed, 1) + ' m/s');
      stat('Photos', plan.photos.length, Math.round(plan.photos.length / Math.max(ha, 0.01)) + ' per ha');
      stat('Route length', fmt(plan.routeLen / 1000, 2) + ' km');
      stat('Flight time', mins(plan.timeS), 'incl. turns and climb');
      stat('Batteries', plan.batteries, 'at ' + fmt(num('usable', 22), 0) + ' usable min each');
      stat('Max speed for shutter', fmt(plan.maxSpeed, 1) + ' m/s', state.cam.minInterval + ' s minimum interval');
    }

    plan.warnings.forEach(function (w) {
      var d = document.createElement('div'); d.className = 'warn ' + w.level; d.textContent = w.text; warns.appendChild(d);
    });
    $('okline').hidden = plan.warnings.some(function (w) { return w.level === 'error'; });
  }

  /* ---------- exports ---------- */
  function download(name, blob) {
    var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  function baseName() {
    var a = ($('author').value || 'capture-plan').replace(/[^\w\-]+/g, '-').replace(/^-+|-+$/g, '') || 'capture-plan';
    return a + '-' + (state.plan ? state.plan.type : 'plan');
  }
  $('exportKML').addEventListener('click', function () {
    if (!state.plan) return;
    download(baseName() + '.kml', new Blob([P.buildKML(state.plan, $('author').value)], { type: 'application/vnd.google-earth.kml+xml' }));
    setStatus('KML exported: polygon, route and ' + state.plan.photos.length + ' photo stations.');
  });
  $('exportCSV').addEventListener('click', function () {
    if (!state.plan) return;
    download(baseName() + '-photos.csv', new Blob([P.buildCSV(state.plan)], { type: 'text/csv' }));
    setStatus('CSV exported: ' + state.plan.photos.length + ' photo points.');
  });
  $('exportWPML').addEventListener('click', function () {
    if (!state.plan) return;
    var plan = state.plan;
    var res = P.buildWPML(plan, { author: $('author').value, mode: $('wpmlMode').value, drone: state.cam.wpml || undefined });
    var zip = new JSZip();
    zip.folder('wpmz').file('template.kml', res.template);
    zip.folder('wpmz').file('waylines.wpml', res.waylines);
    zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.google-earth.kmz', compression: 'DEFLATE' }).then(function (blob) {
      download(baseName() + '.kmz', blob);
      var extra = state.cam.wpml ? '' : ' This camera is not a WPML aircraft; enums default to Mavic 3E. ';
      setStatus('WPML KMZ exported: ' + res.waypointCount + ' waypoints (' + (res.mode === 'perPhoto' ? 'one per photo' : 'line endpoints, distance-triggered photos') + ').' + extra + ' Review in DJI Pilot 2 before flight.');
    });
  });

  /* ---------- initial state ---------- */
  applyCamera('m3e');
  if (saved) {
    if (Array.isArray(saved.poly) && saved.poly.length >= 3) state.poly = saved.poly;
    if (saved.poi && isFinite(saved.poi.lat)) state.poi = saved.poi;
    if (Array.isArray(saved.tiers) && saved.tiers.length) state.tiers = saved.tiers;
  }
  if (!state.poly.length && !state.poi) {
    // Demo site: a field block near Pullman, Michigan, so the page shows a plan immediately.
    state.poly = [
      { lat: 42.4745, lon: -86.0975 }, { lat: 42.4748, lon: -86.0905 },
      { lat: 42.4712, lon: -86.0898 }, { lat: 42.4700, lon: -86.0940 }, { lat: 42.4716, lon: -86.0978 }
    ];
    state.poi = { lat: 42.4726, lon: -86.0938 };
    setStatus('Demo area loaded. Draw your own or import a KML / GeoJSON.');
  }
  renderTiers();
  redrawPolygon(); redrawPOI();
  onMissionChange();
  syncDrive();
  recompute();
  if (!saved || !saved.view) fit();
})();
