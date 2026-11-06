/* Fire Spread Replay & Exposure Timeline. Static page: all data pre-computed by
   georef-splat-tools/examples/fire/build_fire_data.py. Leaflet 1.9.4. No build step. */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const root = document.documentElement;

  // ---------------------------------------------------------------- theme
  (function theme() {
    const btn = $("theme");
    const systemDark = () => window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    const isDark = () => { const t = root.getAttribute("data-theme"); return t ? t === "dark" : systemDark(); };
    const paint = () => { btn.textContent = isDark() ? "Light" : "Dark"; };
    let saved = null;
    try { saved = localStorage.getItem("theme"); } catch (e) { /* private mode */ }
    if (saved === "dark" || saved === "light") root.setAttribute("data-theme", saved);
    paint();
    if (window.matchMedia) {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      const onChange = () => { paint(); document.dispatchEvent(new Event("themechange")); };
      if (mq.addEventListener) mq.addEventListener("change", onChange); else if (mq.addListener) mq.addListener(onChange);
    }
    btn.addEventListener("click", () => {
      const next = isDark() ? "light" : "dark";
      root.setAttribute("data-theme", next);
      try { localStorage.setItem("theme", next); } catch (e) { /* ignore */ }
      paint();
      document.dispatchEvent(new Event("themechange"));
    });
  })();

  const cssVar = (name) => getComputedStyle(root).getPropertyValue(name).trim();
  const CLASS_NAMES = ["inside the burn", "within 1 km", "within 5 km", "within 10 km", "beyond 10 km"];
  const CLASS_SHORT = ["reached", "≤ 1 km", "≤ 5 km", "≤ 10 km", "> 10 km"];
  const THRESH = [0, 1000, 5000, 10000];
  const classOfDist = (d) => { for (let k = 0; k < THRESH.length; k++) if (d <= THRESH[k]) return k; return 4; };
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const fmtDate = (t) => { const d = new Date(t); return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`; };
  const fmtDateY = (t) => { const d = new Date(t); return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`; };
  const fmtBin = (t) => { const d = new Date(t); const h = d.getUTCHours(); return `${fmtDateY(t)} · ${h === 0 ? "00–12" : "12–24"} UTC`; };
  const fmtKm = (m) => (m / 1000).toFixed(m < 10000 ? 1 : 0) + " km";
  const fixOwner = (o) => (o || "").replace(/\bPud\b/g, "PUD").replace(/\bOf\b/g, "of").replace(/\bNo\b/g, "No.");
  const km2acres = (a) => Math.round(a * 247.105);

  const files = ["meta", "steps", "perimeters", "firelines", "newpix", "arrival", "arrival_days", "exposure", "nifc", "buildings"];
  Promise.all(files.map((f) => fetch(`data/${f}.json`).then((r) => { if (!r.ok) throw new Error(`${f}.json ${r.status}`); return r.json(); })))
    .then(([meta, stepsD, perims, flines, newpix, arr, arrDays, expo, nifc, bld]) => init(meta, stepsD, perims, flines, newpix, arr, arrDays, expo, nifc, bld))
    .catch((e) => { console.error(e); $("rDate").textContent = "Failed to load data: " + e.message; });

  // Building centroids drawn straight to a canvas: ~10k points, recoloured per
  // replay step, far cheaper than 10k Leaflet markers.
  const BuildingsLayer = L.Layer.extend({
    initialize(d) { this.d = d; this.step = 0; this.cols = ["#000", "#000", "#000", "#e4ded3"]; },
    onAdd(map) {
      this._map = map;
      this._c = L.DomUtil.create("canvas", "bld-canvas leaflet-zoom-hide");
      map.getPane("overlayPane").appendChild(this._c);
      map.on("moveend zoomend resize", this.redraw, this);
      this.redraw();
    },
    onRemove(map) { map.off("moveend zoomend resize", this.redraw, this); L.DomUtil.remove(this._c); },
    setStep(i) { this.step = i; if (this._map) this.redraw(); },
    setColors(cols) { this.cols = cols; if (this._map) this.redraw(); },
    classAt(k, i) {
      const d = this.d;
      if (d.i0[k] >= 0 && d.i0[k] <= i) return 0;
      if (d.i1[k] >= 0 && d.i1[k] <= i) return 1;
      if (d.i5[k] >= 0 && d.i5[k] <= i) return 2;
      return 3;
    },
    redraw() {
      const map = this._map, c = this._c, size = map.getSize(), dpr = window.devicePixelRatio || 1;
      c.width = size.x * dpr; c.height = size.y * dpr; c.style.width = size.x + "px"; c.style.height = size.y + "px";
      L.DomUtil.setPosition(c, map.containerPointToLayerPoint([0, 0]));
      const ctx = c.getContext("2d"); ctx.scale(dpr, dpr);
      const d = this.d, i = this.step, b = map.getBounds().pad(0.05);
      const s = b.getSouth(), n = b.getNorth(), w = b.getWest(), e = b.getEast();
      const passes = [[3, 1.6], [2, 3], [1, 3.4], [0, 3.8]];
      for (const [cls, r] of passes) {
        ctx.fillStyle = this.cols[cls]; ctx.strokeStyle = cls === 3 ? "rgba(0,0,0,.55)" : "#fff"; ctx.lineWidth = cls === 3 ? 0.6 : 1;
        ctx.globalAlpha = cls === 3 ? 0.8 : 1;
        for (let k = 0; k < d.n; k++) {
          if (this.classAt(k, i) !== cls) continue;
          const lat = d.lat[k], lon = d.lon[k];
          if (lat < s || lat > n || lon < w || lon > e) continue;
          const p = map.latLngToContainerPoint([lat, lon]);
          ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill(); if (cls !== 3 || map.getZoom() >= 12) ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
    },
  });

  function init(meta, stepsD, perims, flines, newpix, arr, arrDays, expo, nifc, bld) {
    const steps = stepsD.steps, daily = stepsD.daily, runs = stepsD.runs;
    const N = steps.length;
    const topRuns = runs.slice().sort((a, b) => b.rate_m_day - a.rate_m_day).slice(0, 5);
    const segs = expo.segments.features;
    const subs = expo.substations;

    // ------------------------------------------------------------- map
    const map = L.map("map", { preferCanvas: true, zoomControl: false, attributionControl: true, zoomSnap: 0.5 });
    L.control.zoom({ position: "topright" }).addTo(map);
    map.attributionControl.setPrefix(false);
    const base = {
      imagery: L.tileLayer("https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}",
        { maxZoom: 16, attribution: "Imagery: USGS The National Map · Fire: NASA FEDS · Lines: HIFLD · Substations: © OpenStreetMap contributors" }),
      topo: L.tileLayer("https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}",
        { maxZoom: 16, attribution: "Topo: USGS The National Map · Fire: NASA FEDS · Lines: HIFLD · Substations: © OpenStreetMap contributors" }),
    };
    base.imagery.addTo(map);
    document.querySelectorAll('input[name="base"]').forEach((r) => r.addEventListener("change", () => {
      Object.values(base).forEach((l) => map.removeLayer(l));
      base[r.value].addTo(map);
    }));
    const b = meta.bounds; // west, south, east, north
    const fireBounds = L.latLngBounds([b[1], b[0]], [b[3], b[2]]);
    map.fitBounds(fireBounds, { paddingTopLeft: [window.innerWidth < 620 ? 0 : 340, 20], paddingBottomRight: [20, 70] });

    const canvas = L.canvas({ padding: 0.5 });
    const fire = () => cssVar("--fire"), fireFill = () => cssVar("--fire-fill");

    // Earlier perimeters, created once, restyled per step.
    const histLayers = perims.features.map((f) => L.geoJSON(f, { renderer: canvas, interactive: false,
      style: { color: fire(), weight: 1.2, opacity: 0, fill: false } }));
    const histGroup = L.layerGroup(histLayers).addTo(map);
    const curLayer = L.geoJSON(null, { renderer: canvas, interactive: false,
      style: { color: fire(), weight: 2.2, opacity: 1, fillColor: fireFill(), fillOpacity: 0.32 } }).addTo(map);
    const flineByStep = {}; flines.features.forEach((f) => { flineByStep[f.properties.i] = f; });
    const flineLayer = L.geoJSON(null, { renderer: canvas, interactive: false, style: { color: "#ff3b1f", weight: 4, opacity: 0.95 } }).addTo(map);
    const pixCache = new Map();
    const pixGroup = L.layerGroup().addTo(map);
    function pixLayerFor(i) {
      if (!pixCache.has(i)) {
        const pts = newpix[String(i)] || [];
        const g = L.layerGroup(pts.map((p) => L.circleMarker([p[1], p[0]], { renderer: canvas, radius: 3, color: "#a04000", weight: 1, fillColor: cssVar("--pix"), fillOpacity: 0.9, interactive: false })));
        pixCache.set(i, g);
      }
      return pixCache.get(i);
    }

    // Arrival-time raster + hover readout.
    const arrBounds = L.latLngBounds([arr.south, arr.west], [arr.north, arr.east]);
    const arrLayer = L.imageOverlay("data/arrival.png", arrBounds, { opacity: 0.88, interactive: false, className: "arr-img" });
    const arrTip = L.tooltip({ className: "arr", direction: "top", offset: [0, -8], opacity: 1 });
    function arrivalAt(latlng) {
      if (!arrBounds.contains(latlng)) return null;
      const col = Math.floor((latlng.lng - arr.west) / (arr.east - arr.west) * arr.nx);
      const row = Math.floor((arr.north - latlng.lat) / (arr.north - arr.south) * arr.ny);
      const v = arrDays.v[row * arrDays.nx + col];
      return v < 0 ? null : v * arrDays.scale;
    }
    map.on("mousemove", (e) => {
      if (!map.hasLayer(arrLayer)) return;
      const d = arrivalAt(e.latlng);
      if (d === null) { if (map.hasLayer(arrTip)) map.removeLayer(arrTip); return; }
      const t = new Date(new Date(arr.t0).getTime() + d * 86400000);
      arrTip.setLatLng(e.latlng).setContent(`First burned ≈ <b>${fmtDate(t)}</b> (day ${d.toFixed(1)})`);
      if (!map.hasLayer(arrTip)) arrTip.addTo(map);
    });
    map.on("mouseout", () => { if (map.hasLayer(arrTip)) map.removeLayer(arrTip); });
    (function arrivalLegend() {
      $("arrRamp").style.background = `linear-gradient(90deg, ${arr.ramp.join(",")})`;
      const st = arr.stops, pick = [0, Math.floor(st.length / 3), Math.floor(2 * st.length / 3), st.length - 1];
      $("arrTicks").innerHTML = pick.map((k) => `<span>${fmtDate(st[k].date + "T00:00:00Z")}</span>`).join("");
    })();

    // Spread runs as arrows.
    const runGroup = L.layerGroup();
    function arrowHead(to, bearingDeg, lenM, halfM) {
      const lat = to[1], kx = 111320 * Math.cos(lat * Math.PI / 180), ky = 110574;
      const br = bearingDeg * Math.PI / 180;
      const ux = Math.sin(br), uy = Math.cos(br), px = Math.cos(br), py = -Math.sin(br);
      const pt = (dx, dy) => [to[1] + dy / ky, to[0] + dx / kx];
      return [pt(0, 0), pt(-ux * lenM + px * halfM, -uy * lenM + py * halfM), pt(-ux * lenM - px * halfM, -uy * lenM - py * halfM)];
    }
    topRuns.forEach((r, k) => {
      const a = [r.from[1], r.from[0]], z = [r.to[1], r.to[0]];
      const halo = L.polyline([a, z], { renderer: canvas, color: "#000", weight: 6, opacity: 0.55, dashArray: r.detached ? "8 8" : null });
      const line = L.polyline([a, z], { renderer: canvas, color: "#fff", weight: 2.5, opacity: 1, dashArray: r.detached ? "8 8" : null });
      const head = L.polygon(arrowHead(r.to, r.bearing_deg, 900, 420), { renderer: canvas, color: "#000", weight: 1, fillColor: "#fff", fillOpacity: 1 });
      const lbl = L.tooltip({ permanent: true, direction: "right", offset: [8, 0], className: "runlbl", interactive: true })
        .setLatLng(z).setContent(`#${k + 1} ${(r.rate_m_day / 1000).toFixed(1)} km/d ${r.compass}`);
      const popup = `<b>Run #${k + 1}</b><br>${fmtBin(r.t)}<br>Advance ${(r.advance_m / 1000).toFixed(1)} km in ${r.dt_days} d → ${(r.rate_m_day / 1000).toFixed(1)} km/day, toward ${r.compass} (${r.bearing_deg}°)` +
        (r.detached ? "<br><i>Detached from the previous perimeter: spot fire, second ignition or merged event.</i>" : "") +
        `<br><a href="#" data-step="${r.i}">Jump replay to this step</a>`;
      [halo, line, head].forEach((l) => l.bindPopup(popup));
      runGroup.addLayer(halo); runGroup.addLayer(line); runGroup.addLayer(head); runGroup.addLayer(lbl);
    });
    map.on("popupopen", (e) => {
      const a = e.popup.getElement().querySelector("a[data-step]");
      if (a) a.addEventListener("click", (ev) => { ev.preventDefault(); setStep(+a.dataset.step); map.closePopup(); });
    });

    // Exposure: segments and substations.
    const expGroup = L.layerGroup().addTo(map);
    const segLayers = segs.map((f) => {
      const p = f.properties;
      const pl = L.geoJSON(f, { renderer: canvas, style: { color: cssVar("--c4"), weight: 2, opacity: 0.9 } });
      pl.bindPopup(() => segPopup(p));
      pl.on("click", () => selectRow(p.id));
      expGroup.addLayer(pl);
      return pl;
    });
    const subLayers = subs.map((s) => {
      const m = L.circleMarker([s.lat, s.lon], { renderer: canvas, radius: 6, color: "#000", weight: 1, fillColor: cssVar("--sub"), fillOpacity: 0.95 });
      m.bindPopup(() => subPopup(s));
      m.on("click", () => selectRow(s.id));
      expGroup.addLayer(m);
      return m;
    });
    const tOr = (t) => (t ? fmtBin(t) : "never");
    function timingRows(p) {
      return `<br>First ≤ 10 km: ${tOr(p.first_10km)}<br>First ≤ 5 km: ${tOr(p.first_5km)}<br>First ≤ 1 km: ${tOr(p.first_1km)}<br>Reached: ${tOr(p.first_0m)}` +
        `<br>Closest: <b>${fmtKm(p.min_dist_m)}</b> on ${fmtDate(p.min_dist_t)}`;
    }
    function segPopup(p) {
      return `<b>${p.id}</b> · ${fixOwner(p.owner)} ${p.kv ? p.kv + " kV" : ""}<br>${p.from} → ${p.to} · ${p.len_m} m segment · ${p.type || ""}` +
        `<br>Status: <b>${CLASS_NAMES[p.class]}</b>` + timingRows(p);
    }
    function subPopup(s) {
      return `<b>${s.name}</b> (substation, OSM)${s.operator ? "<br>" + s.operator : ""}${s.kv ? " · " + s.kv + " V" : ""}${s.kind ? " · " + s.kind : ""}` +
        `<br>Status: <b>${CLASS_NAMES[s.class]}</b>` + timingRows(s) + `<br><a href="${s.osm}" target="_blank" rel="noopener">OSM object</a>`;
    }
    function styleExposure(i) {
      // on imagery the "beyond 10 km" lines need a light stroke, whatever the page theme
      const cols = [cssVar("--c0"), cssVar("--c1"), cssVar("--c2"), cssVar("--c3"), "#e4ded3"];
      const weights = [6, 5, 4, 4, 2];
      segs.forEach((f, k) => {
        const c = classOfDist(f.properties.dist_series_m[i]);
        segLayers[k].setStyle({ color: cols[c], weight: weights[c], opacity: c === 4 ? 0.85 : 1 });
      });
      subs.forEach((s, k) => {
        const c = classOfDist(s.dist_series_m[i]);
        subLayers[k].setStyle({ radius: c === 4 ? 6 : 8, fillColor: c === 4 ? cssVar("--sub") : cols[c], color: c === 4 ? "#000" : "#fff" });
      });
    }

    // NIFC perimeter.
    const nifcLayer = nifc ? L.geoJSON(nifc.geometry, { renderer: canvas, interactive: false, style: { color: cssVar("--nifc"), weight: 2.2, dashArray: "7 6", fill: false } }) : null;

    // Buildings (canvas) + the ranked 500 m clusters as outlines.
    const bldCols = () => [cssVar("--c0"), cssVar("--c1"), cssVar("--c2"), "#e4ded3"];
    const bldLayer = new BuildingsLayer(bld);
    bldLayer.setColors(bldCols());
    const clusterRects = bld.clusters.map((c) => {
      const r = L.rectangle([[c.bounds[1], c.bounds[0]], [c.bounds[3], c.bounds[2]]], { renderer: canvas, color: cssVar("--c0"), weight: 2, dashArray: "5 4", fill: true, fillOpacity: 0.05 });
      r.bindTooltip(`#${c.rank}: ${c.inside} inside, ${c.within_1km} ≤ 1 km`, { className: "runlbl", direction: "top" });
      r.bindPopup(() => `<b>Cluster #${c.rank}</b> (${c.id}, ${bld.cell_m} m cell)<br>${c.n} OSM buildings<br>Inside FEDS perimeter: <b>${c.inside}</b>${c.first_inside ? ", first " + fmtBin(c.first_inside) : ""}<br>Within 1 km: ${c.within_1km}${c.first_1km ? ", first " + fmtBin(c.first_1km) : ""}<br>Inside NIFC final perimeter: <b>${c.nifc_inside}</b>` +
        (c.first_inside ? `<br><a href="#" data-step="${steps.findIndex((s) => s.t === c.first_inside)}">Jump replay to first arrival</a>` : ""));
      return r;
    });
    const bldGroup = L.layerGroup([bldLayer, ...clusterRects]);

    // Layer toggles → map and legend rows.
    const toggles = [
      ["tHist", histGroup, null], ["tFline", flineLayer, ".lg-fline"], ["tPix", pixGroup, ".lg-pix"],
      ["tArr", arrLayer, ".lg-arr"], ["tRuns", runGroup, ".lg-runs"], ["tExp", expGroup, ".lg-exp"], ["tBld", bldGroup, ".lg-bld"], ["tNifc", nifcLayer, ".lg-nifc"],
    ];
    toggles.forEach(([id, layer, sel]) => {
      const cb = $(id);
      if (!layer) { cb.disabled = true; return; }
      const apply = () => {
        if (cb.checked) { if (!map.hasLayer(layer)) layer.addTo(map); } else if (map.hasLayer(layer)) map.removeLayer(layer);
        if (sel) document.querySelectorAll(`#legend ${sel}`).forEach((el) => { el.hidden = !cb.checked; });
        if (id === "tArr" && cb.checked) { curLayer.setStyle({ fillOpacity: 0.05 }); } else if (id === "tArr") { curLayer.setStyle({ fillOpacity: 0.32 }); }
        if (id === "tArr" && !cb.checked && map.hasLayer(arrTip)) map.removeLayer(arrTip);
      };
      cb.addEventListener("change", apply);
      apply();
    });
    $("hide").addEventListener("click", (e) => {
      const p = $("panel"); p.classList.toggle("min");
      const min = p.classList.contains("min");
      e.target.textContent = min ? "show" : "hide";
      e.target.setAttribute("aria-expanded", String(!min));
    });

    // ------------------------------------------------------------ replay
    const slider = $("step");
    slider.max = String(N - 1);
    let cur = -1;
    function setStep(i) {
      i = Math.max(0, Math.min(N - 1, i | 0));
      if (i === cur) return;
      cur = i;
      const s = steps[i];
      slider.value = String(i);
      slider.setAttribute("aria-valuetext", `${fmtBin(s.t)}, ${s.area_km2} square kilometres`);
      $("stepOut").textContent = `${i + 1}/${N} · ${fmtDate(s.t)}`;
      $("rDate").textContent = fmtBin(s.t);
      $("rArea").innerHTML = `${s.area_km2.toLocaleString()} km² <small>${km2acres(s.area_km2).toLocaleString()} ac</small>`;
      $("rGrowth").innerHTML = s.growth_km2_day === null ? "first detection" : `${s.growth_km2 >= 0 ? "+" : ""}${s.growth_km2} km² <small>${s.growth_km2_day} km²/day</small>`;
      $("rFline").textContent = s.fline_km ? `${s.fline_km} km` : "none";
      $("rFrp").textContent = s.mean_frp_mw === null ? "–" : `${s.mean_frp_mw} MW`;
      $("rPix").textContent = s.n_newpixels.toLocaleString();
      const near = segs.reduce((m, f) => Math.min(m, f.properties.dist_series_m[i]), Infinity);
      const n10 = segs.filter((f) => f.properties.dist_series_m[i] <= 10000).length;
      $("rExp").innerHTML = `${n10} <small>nearest ${fmtKm(near)}</small>`;

      curLayer.clearLayers(); curLayer.addData(perims.features[i]);
      histLayers.forEach((l, j) => {
        if (j >= i) { l.setStyle({ opacity: 0 }); return; }
        const age = i - j;                         // steps ago
        l.setStyle({ opacity: Math.max(0.1, 0.85 * Math.pow(0.93, age)) });
      });
      flineLayer.clearLayers(); if (flineByStep[i]) flineLayer.addData(flineByStep[i]);
      pixGroup.clearLayers(); pixGroup.addLayer(pixLayerFor(i));
      styleExposure(i);
      bldLayer.setStep(i);
      $("rBld").innerHTML = `${bld.cum.inside[i].toLocaleString()} <small>${bld.cum.within_1km[i].toLocaleString()} ≤ 1 km · ${bld.cum.within_5km[i].toLocaleString()} ≤ 5 km</small>`;
      drawCursor(i);
    }
    slider.addEventListener("input", () => setStep(+slider.value));

    let timer = null;
    const playBtn = $("play");
    function stop() { if (timer) clearInterval(timer); timer = null; playBtn.textContent = "▶"; playBtn.setAttribute("aria-label", "Play replay"); playBtn.setAttribute("aria-pressed", "false"); }
    function play() {
      if (cur >= N - 1) setStep(0);
      playBtn.textContent = "❚❚"; playBtn.setAttribute("aria-label", "Pause replay"); playBtn.setAttribute("aria-pressed", "true");
      timer = setInterval(() => { if (cur >= N - 1) { stop(); return; } setStep(cur + 1); }, 320);
    }
    playBtn.addEventListener("click", () => (timer ? stop() : play()));
    slider.addEventListener("pointerdown", stop);

    // ------------------------------------------------------------ charts
    const tip = $("chartTip");
    const chartsSection = document.querySelector("section.charts");
    function showTip(evt, html) {
      const r = chartsSection.getBoundingClientRect();
      tip.innerHTML = html; tip.hidden = false;
      let x = evt.clientX - r.left + 12, y = evt.clientY - r.top - 34;
      if (x + tip.offsetWidth > r.width) x = evt.clientX - r.left - tip.offsetWidth - 12;
      tip.style.left = x + "px"; tip.style.top = y + "px";
    }
    const hideTip = () => { tip.hidden = true; };

    const dayMax = steps[N - 1].day;
    const t0ms = new Date(steps[0].t).getTime();
    const dayToDate = (d) => new Date(t0ms + d * 86400000);
    const dateToDay = (iso) => (new Date(iso + "T00:00:00Z").getTime() - t0ms) / 86400000;
    const stepOfDay = (d) => { let best = 0; for (let i = 0; i < N; i++) if (Math.abs(steps[i].day - d) < Math.abs(steps[best].day - d)) best = i; return best; };
    const monthTicks = (() => {
      const out = []; const d0 = dayToDate(0), d1 = dayToDate(dayMax);
      for (let m = new Date(Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth(), 1)); m <= d1; m = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 1))) {
        for (const dd of [1, 15]) { const t = Date.UTC(m.getUTCFullYear(), m.getUTCMonth(), dd); const day = (t - t0ms) / 86400000; if (day >= 0 && day <= dayMax) out.push({ day, label: `${MONTHS[m.getUTCMonth()]} ${dd}` }); }
      }
      return out;
    })();
    const SVG = "http://www.w3.org/2000/svg";
    const el = (n, a, parent) => { const e = document.createElementNS(SVG, n); for (const k in a) e.setAttribute(k, a[k]); if (parent) parent.appendChild(e); return e; };
    let cursorEls = [];
    function frame(host, yMax, yStep) {
      host.innerHTML = "";
      const W = host.clientWidth || 400, H = host.clientHeight || 190, ml = 40, mr = 8, mt = 8, mb = 22;
      const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H }, host);
      const x = (d) => ml + (d / dayMax) * (W - ml - mr), y = (v) => mt + (1 - v / yMax) * (H - mt - mb);
      const grid = el("g", { class: "grid" }, svg), axis = el("g", { class: "axis" }, svg);
      for (let v = 0; v <= yMax; v += yStep) { el("line", { x1: ml, x2: W - mr, y1: y(v), y2: y(v) }, grid); const t = el("text", { x: ml - 6, y: y(v) + 4, "text-anchor": "end" }, axis); t.textContent = v; }
      (W < 420 ? monthTicks.filter((tk) => tk.label.endsWith(" 1")) : monthTicks).forEach((tk) => { const t = el("text", { x: x(tk.day), y: H - 6, "text-anchor": "middle" }, axis); t.textContent = tk.label; });
      return { svg, x, y, W, H, ml, mr, mt, mb };
    }
    function drawCharts() {
      cursorEls = [];
      // Area over time (single series: no legend needed)
      const hostA = $("chartArea"), aMax = Math.ceil(steps[N - 1].area_km2 / 200) * 200;
      const A = frame(hostA, aMax, 200);
      const pts = steps.map((s) => `${A.x(s.day).toFixed(1)},${A.y(s.area_km2).toFixed(1)}`);
      el("path", { class: "area", d: `M${A.x(0)},${A.y(0)} L${pts.join(" L")} L${A.x(dayMax)},${A.y(0)} Z` }, A.svg);
      el("path", { class: "series", d: `M${pts.join(" L")}` }, A.svg);
      const cursA = el("line", { class: "cursor", y1: A.mt, y2: A.H - A.mb }, A.svg);
      const dotA = el("circle", { class: "cursor-dot", r: 4 }, A.svg);
      cursorEls.push((i) => { const cx = A.x(steps[i].day); cursA.setAttribute("x1", cx); cursA.setAttribute("x2", cx); dotA.setAttribute("cx", cx); dotA.setAttribute("cy", A.y(steps[i].area_km2)); });
      const hitA = el("rect", { class: "hit", x: A.ml, y: 0, width: A.W - A.ml - A.mr, height: A.H }, A.svg);
      const dayAt = (evt) => { const r = hitA.getBoundingClientRect(); return Math.max(0, Math.min(dayMax, (evt.clientX - r.left) / r.width * dayMax)); };
      hitA.addEventListener("pointermove", (evt) => { const i = stepOfDay(dayAt(evt)); showTip(evt, `${fmtDate(steps[i].t)}: <b>${steps[i].area_km2} km²</b>`); if (evt.buttons & 1) setStep(i); });
      hitA.addEventListener("pointerdown", (evt) => { stop(); setStep(stepOfDay(dayAt(evt))); });
      hitA.addEventListener("pointerleave", hideTip);

      // Growth per calendar day (bars)
      const hostG = $("chartGrowth"), gMax = Math.ceil(Math.max(...daily.map((d) => d.growth_km2)) / 50) * 50;
      const G = frame(hostG, gMax, 50);
      const bw = Math.max(2, (G.W - G.ml - G.mr) / (dayMax + 1) - 1.5);
      const peakDate = meta.peak_growth.date;
      daily.forEach((d) => {
        if (d.growth_km2 <= 0) return;
        const day = dateToDay(d.date);
        const r = el("rect", { class: "bar" + (d.date === peakDate ? " peak" : ""), x: G.x(day) - bw / 2, y: G.y(d.growth_km2), width: bw, height: G.y(0) - G.y(d.growth_km2), rx: 1.5 }, G.svg);
        r.addEventListener("pointermove", (evt) => showTip(evt, `${fmtDate(d.date + "T00:00:00Z")}: <b>+${d.growth_km2} km²</b>${d.span_days > 1 ? ` over ${d.span_days} days` : ""}`));
        r.addEventListener("pointerleave", hideTip);
        r.addEventListener("click", () => { stop(); setStep(stepOfDay(day + 0.5)); });
        if (d.date === peakDate) { const t = el("text", { class: "lbl-peak", x: Math.min(G.x(day) + 8, G.W - 90), y: G.y(d.growth_km2) + 10 }, G.svg); t.textContent = `+${Math.round(d.growth_km2)} km² ${fmtDate(d.date + "T00:00:00Z")}`; }
      });
      const cursG = el("line", { class: "cursor", y1: G.mt, y2: G.H - G.mb }, G.svg);
      cursorEls.push((i) => { const cx = G.x(steps[i].day); cursG.setAttribute("x1", cx); cursG.setAttribute("x2", cx); });

      // Buildings exposed, cumulative: three small multiples, each its own scale
      const niceMax = (v) => { const p = Math.pow(10, Math.floor(Math.log10(Math.max(v, 1)))); const m = Math.ceil(v / p); return (m <= 2 ? 2 : m <= 5 ? 5 : 10) * p; };
      [["chartB5", bld.cum.within_5km, 2, "within 5 km"], ["chartB1", bld.cum.within_1km, 1, "within 1 km"], ["chartB0", bld.cum.inside, 0, "inside"]].forEach(([id, series, cls, name]) => {
        const host = $(id), yMax = niceMax(series[N - 1]);
        const C = frame(host, yMax, yMax / 2);
        const pts = steps.map((s, i) => `${C.x(s.day).toFixed(1)},${C.y(series[i]).toFixed(1)}`);
        el("path", { class: `area c${cls}`, d: `M${C.x(0)},${C.y(0)} L${pts.join(" L")} L${C.x(dayMax)},${C.y(0)} Z` }, C.svg);
        el("path", { class: `series c${cls}`, d: `M${pts.join(" L")}` }, C.svg);
        const t = el("text", { class: "end-lbl", x: C.W - C.mr, y: Math.max(C.y(series[N - 1]) - 9, 11), "text-anchor": "end" }, C.svg);
        t.textContent = `${series[N - 1].toLocaleString()} ${name}`;
        const cu = el("line", { class: "cursor", y1: C.mt, y2: C.H - C.mb }, C.svg);
        const dot = el("circle", { class: "cursor-dot", r: 3.5 }, C.svg);
        cursorEls.push((i) => { const cx = C.x(steps[i].day); cu.setAttribute("x1", cx); cu.setAttribute("x2", cx); dot.setAttribute("cx", cx); dot.setAttribute("cy", C.y(series[i])); });
        const hit = el("rect", { class: "hit", x: C.ml, y: 0, width: C.W - C.ml - C.mr, height: C.H }, C.svg);
        const dAt = (evt) => { const r = hit.getBoundingClientRect(); return Math.max(0, Math.min(dayMax, (evt.clientX - r.left) / r.width * dayMax)); };
        hit.addEventListener("pointermove", (evt) => { const i = stepOfDay(dAt(evt)); showTip(evt, `${fmtDate(steps[i].t)}: <b>${series[i].toLocaleString()}</b> buildings ${name}`); if (evt.buttons & 1) setStep(i); });
        hit.addEventListener("pointerdown", (evt) => { stop(); setStep(stepOfDay(dAt(evt))); });
        hit.addEventListener("pointerleave", hideTip);
      });
      if (cur >= 0) drawCursor(cur);
    }
    function drawCursor(i) { cursorEls.forEach((f) => f(i)); }
    let rs = null;
    window.addEventListener("resize", () => { clearTimeout(rs); rs = setTimeout(drawCharts, 150); });
    document.addEventListener("themechange", () => {
      styleExposure(cur); bldLayer.setColors(bldCols()); clusterRects.forEach((r) => r.setStyle({ color: cssVar("--c0") }));
      if (nifcLayer) nifcLayer.setStyle({ color: cssVar("--nifc") });
    });
    drawCharts();

    // ------------------------------------------------------- runs table
    $("runsTable").querySelector("tbody").innerHTML = topRuns.map((r, k) =>
      `<tr><td>${fmtBin(r.t)}</td><td class="n">${(r.advance_m / 1000).toFixed(1)} km in ${r.dt_days} d</td><td class="n">${(r.rate_m_day / 1000).toFixed(1)} km/day</td><td>${r.compass} <span class="mono">${r.bearing_deg}°</span></td><td>${r.detached ? "new detached patch" : "contiguous growth"} · <button type="button" class="linkbtn" data-step="${r.i}">show</button></td></tr>`).join("");
    document.querySelectorAll("#runsTable button[data-step]").forEach((bt) => bt.addEventListener("click", () => {
      stop(); setStep(+bt.dataset.step); $("tRuns").checked = true; $("tRuns").dispatchEvent(new Event("change"));
      const r = topRuns.find((x) => x.i === +bt.dataset.step); if (r) map.fitBounds(L.latLngBounds([[r.from[1], r.from[0]], [r.to[1], r.to[0]]]).pad(0.6));
      $("stage").scrollIntoView({ behavior: "smooth", block: "start" });
    }));

    // --------------------------------------------------- exposure table
    const ex = meta.exposure;
    const rows = segs.map((f) => Object.assign({ kind: "line" }, f.properties)).concat(subs.map((s) => Object.assign({ kind: "sub", owner: s.operator || "", id: s.name === "(unnamed)" ? `${s.id} (unnamed)` : s.name, _id: s.id }, s)));
    rows.forEach((r) => { if (!r._id) r._id = r.id; });
    const subsIn10 = ex.substations_by_class.slice(0, 4).reduce((a, b) => a + b, 0);
    $("expSummary").innerHTML = `Tested <b>${ex.segments} transmission segments</b> (${ex.lines} HIFLD lines clipped to the fire's bounding box plus ${ex.margin_km} km, cut into ~${ex.segment_m / 1000} km pieces) and <b>${ex.substations} OSM substations</b> against all ${meta.n_snapshots} FEDS perimeters. ` +
      `Reached: ${ex.inside} segments. Within 1 km: ${ex.within_1km}. Within 5 km: ${ex.within_5km}. Within 10 km: ${ex.within_10km} segments and ${subsIn10} substation${subsIn10 === 1 ? "" : "s"}. ` +
      `Closest approach overall: <b>${fmtKm(ex.closest.min_dist_m)}</b>, segment ${ex.closest.id} (${fixOwner(ex.closest.owner)}, ${ex.closest.kv} kV) on ${fmtDate(ex.closest.min_dist_t)}.`;
    $("expStats").innerHTML = [
      [ex.inside, "segments reached by the perimeter", 0], [ex.within_1km, "segments within 1 km", 1], [ex.within_5km, "segments within 5 km", 2],
      [ex.within_10km, `segments within 10 km <br>+ ${subsIn10} substation${subsIn10 === 1 ? "" : "s"}`, 3]]
      .map(([n, l, c]) => `<div class="stat"><div class="n"><span class="cls c${c}">${n}</span></div><div class="l">${l}</div></div>`).join("");
    $("expVerdict").textContent = ex.within_5km === 0 && ex.substations_by_class[0] + ex.substations_by_class[1] + ex.substations_by_class[2] === 0
      ? `no mapped transmission segment or substation came within 5 km of the satellite perimeter at any point in the ${meta.n_snapshots} snapshots. The closest approach was ${fmtKm(ex.closest.min_dist_m)}, on ${fmtDateY(ex.closest.min_dist_t)}.`
      : `${ex.inside} segments were reached and ${ex.within_1km} more came within 1 km; see the table.`;

    let sortK = "class", sortDir = 1;
    const tbody = $("expTable").querySelector("tbody");
    function renderTable() {
      const f = $("expFilter").value;
      let list = rows.filter((r) => f === "all" || (f === "exposed" && r.class < 4) || (f === "lines" && r.kind === "line") || (f === "subs" && r.kind === "sub"));
      const key = (r) => { const v = r[sortK]; if (sortK === "class") return r.class * 1e12 + (new Date(r.first_10km || r.first_5km || "2099-01-01").getTime() / 1000) + r.min_dist_m / 1e6; if (v === null || v === undefined || v === "") return sortDir > 0 ? "￿" : ""; return v; };
      list.sort((a, b) => { const ka = key(a), kb = key(b); return (ka > kb ? 1 : ka < kb ? -1 : 0) * sortDir; });
      tbody.innerHTML = list.map((r) => `<tr data-id="${r._id}" tabindex="0"><td>${r.kind === "line" ? `<span class="mono">${r.id}</span><br><span class="small">${r.from} → ${r.to}</span>` : `${r.id}<br><span class="small">substation · OSM</span>`}</td>` +
        `<td>${fixOwner(r.owner) || "<span class='small'>unknown</span>"}${r.kv ? `<br><span class="small">${r.kind === "line" ? r.kv + " kV" : r.kv + " V"}</span>` : ""}</td>` +
        `<td><span class="cls c${r.class}">${CLASS_SHORT[r.class]}</span></td>` +
        `<td class="n">${r.first_10km ? fmtDate(r.first_10km) : "–"}</td><td class="n">${r.first_5km ? fmtDate(r.first_5km) : "–"}</td><td class="n">${r.first_1km ? fmtDate(r.first_1km) : "–"}</td><td class="n">${r.first_0m ? fmtDate(r.first_0m) : "–"}</td>` +
        `<td class="n">${fmtKm(r.min_dist_m)} <span class="small">${fmtDate(r.min_dist_t)}</span></td></tr>`).join("") ||
        `<tr><td colspan="8" class="small">Nothing in this filter.</td></tr>`;
      document.querySelectorAll("#expTable th button").forEach((bt) => bt.setAttribute("aria-sort", bt.dataset.k === sortK ? (sortDir > 0 ? "ascending" : "descending") : "none"));
    }
    document.querySelectorAll("#expTable th button").forEach((bt) => bt.addEventListener("click", () => {
      if (sortK === bt.dataset.k) sortDir = -sortDir; else { sortK = bt.dataset.k; sortDir = 1; }
      renderTable();
    }));
    $("expFilter").addEventListener("change", renderTable);
    tbody.addEventListener("click", (e) => { const tr = e.target.closest("tr[data-id]"); if (tr) focusAsset(tr.dataset.id); });
    tbody.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { const tr = e.target.closest("tr[data-id]"); if (tr) { e.preventDefault(); focusAsset(tr.dataset.id); } } });
    renderTable();

    function selectRow(id) { tbody.querySelectorAll("tr.sel").forEach((t) => t.classList.remove("sel")); const tr = tbody.querySelector(`tr[data-id="${id}"]`); if (tr) tr.classList.add("sel"); }
    function focusAsset(id) {
      selectRow(id);
      if (!$("tExp").checked) { $("tExp").checked = true; $("tExp").dispatchEvent(new Event("change")); }
      const k = segs.findIndex((f) => f.properties.id === id);
      let layer = null, p = null;
      if (k >= 0) { layer = segLayers[k]; p = segs[k].properties; }
      else { const j = subs.findIndex((s) => s.id === id); if (j >= 0) { layer = subLayers[j]; p = subs[j]; } }
      if (!layer) return;
      // jump the replay to the closest-approach step so the context is right
      const i = steps.findIndex((s) => s.t === p.min_dist_t); if (i >= 0) { stop(); setStep(i); }
      const bb = layer.getBounds ? layer.getBounds() : L.latLngBounds([layer.getLatLng()]);
      map.fitBounds(bb.pad(k >= 0 ? 3 : 0.1), { maxZoom: 12 });
      layer.openPopup(bb.getCenter());
      $("stage").scrollIntoView({ behavior: "smooth", block: "start" });
    }

    // ------------------------------------------------------------ queue
    const queue = segs.map((f) => f.properties).filter((p) => p.rank).sort((a, b) => a.rank - b.rank).slice(0, 30);
    $("queueList").innerHTML = queue.length ? queue.map((p) => {
      const when = p.first_0m ? `reached ${fmtDate(p.first_0m)}` : p.first_1km ? `≤ 1 km ${fmtDate(p.first_1km)}` : p.first_5km ? `≤ 5 km ${fmtDate(p.first_5km)}` : `≤ 10 km ${fmtDate(p.first_10km)}`;
      return `<li><div><button type="button" data-id="${p.id}">${p.id}</button> <span class="cls c${p.class}">${CLASS_SHORT[p.class]}</span><span class="who">${fixOwner(p.owner)} ${p.kv} kV · ${p.from} → ${p.to} · ${p.len_m} m</span></div><div class="when">${when}<br>min ${fmtKm(p.min_dist_m)}</div></li>`;
    }).join("") : `<li>No segment came within 10 km; the queue is empty.</li>`;
    $("queueList").addEventListener("click", (e) => { const bt = e.target.closest("button[data-id]"); if (bt) focusAsset(bt.dataset.id); });

    // Building clusters queue
    $("clusterCell").textContent = `${bld.cell_m} m`;
    $("clusterList").innerHTML = bld.clusters.length ? bld.clusters.map((c) =>
      `<li><div><button type="button" data-rank="${c.rank}">${c.id}</button> <span class="cnt">${c.inside} inside · ${c.within_1km} ≤ 1 km · ${c.nifc_inside} inside NIFC</span><span class="who">${c.n} OSM buildings in the cell</span></div><div class="when">${c.first_inside ? "inside " + fmtDate(c.first_inside) : "≤ 1 km " + fmtDate(c.first_1km)}</div></li>`).join("")
      : "<li>No building came within 1 km of the perimeter.</li>";
    $("clusterList").addEventListener("click", (e) => {
      const bt = e.target.closest("button[data-rank]"); if (!bt) return;
      const c = bld.clusters[+bt.dataset.rank - 1], r = clusterRects[+bt.dataset.rank - 1];
      if (!$("tBld").checked) { $("tBld").checked = true; $("tBld").dispatchEvent(new Event("change")); }
      const i = steps.findIndex((s) => s.t === (c.first_inside || c.first_1km)); if (i >= 0) { stop(); setStep(i); }
      map.fitBounds(r.getBounds().pad(1.5), { maxZoom: 14 });
      r.openPopup();
      $("stage").scrollIntoView({ behavior: "smooth", block: "start" });
    });

    // ------------------------------------------------------------ notes
    $("nT0").textContent = fmtDateY(meta.t_first);
    $("nT1").textContent = fmtDateY(meta.t_last);
    $("nBld").textContent = bld.n.toLocaleString();
    $("builtDate").textContent = meta.built;

    // Buildings summary, FEDS vs NIFC
    const B = meta.buildings, bf = B.feds, bn = B.nifc;
    $("bldSummary").innerHTML = `Of <b>${B.n.toLocaleString()} OSM buildings</b> within the search box, <b>${bf.inside} had their centroid inside the FEDS perimeter at some point</b> (first on ${fmtDateY(B.first_inside_t)}), ${bf.within_1km} came within 1 km and ${bf.within_5km.toLocaleString()} within 5 km. ` +
      (bn ? `Against the official NIFC final perimeter the same buildings give <b>${bn.inside} inside</b>, ${bn.within_1km} within 1 km and ${bn.within_5km.toLocaleString()} within 5 km. The gap in the first column (${bf.inside} vs ${bn.inside}) is the 375 m perimeter uncertainty made concrete: it is why a satellite count is a list to check, not a loss figure.` : "");
    const pct = (a, b2) => (b2 ? ` <span class="small">(${Math.round(a / b2 * 100)}% of OSM)</span>` : "");
    $("bldTable").querySelector("tbody").innerHTML = [
      ["Centroid inside the perimeter", bf.inside, bn && bn.inside],
      ["Within 1 km (includes inside)", bf.within_1km, bn && bn.within_1km],
      ["Within 5 km (includes inside)", bf.within_5km, bn && bn.within_5km],
      ["Beyond 5 km", B.n - bf.within_5km, bn && B.n - bn.within_5km],
    ].map(([l, a, b2]) => `<tr><td>${l}</td><td class="n">${a.toLocaleString()}${pct(a, B.n)}</td><td class="n">${b2 === null || b2 === undefined ? "–" : b2.toLocaleString() + pct(b2, B.n)}</td></tr>`).join("");
    $("bldCoverage").textContent = `${B.n.toLocaleString()} footprints in a ${ex.margin_km} km box around the fire, tagged mostly ${Object.entries(B.tags).slice(0, 3).map(([k, v]) => `${k} (${v.toLocaleString()})`).join(", ")}, which points to a mix of hand tracing and bulk imports.`;
    if (nifc) {
      const pct = Math.round((nifc.feds_final_km2 / nifc.area_km2 - 1) * 100);
      $("nifcText").innerHTML = `NIFC's WFIGS perimeter for Little Giant (${nifc.source}, polygon dated ${nifc.polygon_date}, "${nifc.map_method}") is <b>${nifc.gis_acres.toLocaleString()} acres = ${(nifc.gis_acres / 247.105).toFixed(0)} km²</b>. The final FEDS perimeter is <b>${meta.final_area_km2} km²</b>, about <b>${pct}% larger</b>. They share ${nifc.intersection_km2} km² (intersection over union ${nifc.iou}); FEDS marks ${nifc.feds_only_km2} km² that NIFC does not, and NIFC has ${nifc.nifc_only_km2} km² that FEDS never saw burning.`;
    } else {
      $("nifcText").textContent = "The NIFC comparison could not be fetched when the data was built.";
    }

    // start
    setStep(0);
  }
})();
