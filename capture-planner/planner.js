/* Capture Planner — geometry, mission maths and export builders.
   Plain functions, no DOM, no dependencies. Loaded by index.html and tests.html.
   Units: metres, degrees, cm/px for GSD. Headings are degrees clockwise from north. */
(function (global) {
  'use strict';

  var DEG = Math.PI / 180;
  var R_EARTH = 6378137;          // WGS84 semi-major axis, fine for mission-scale local frames
  var FT_PER_M = 3.28084;
  var PART107_LIMIT_M = 400 / FT_PER_M;   // 121.92 m AGL

  /* ---------------- Camera presets ----------------
     sensorW/sensorH mm, focal mm (real, not 35 mm equivalent), pxW/pxH, minInterval s.
     'verify' marks values I could not confirm against a DJI spec sheet and estimated from
     sensor format and 35 mm-equivalent focal length. Check before relying on them. */
  var CAMERAS = [
    { id: 'm3e', name: 'DJI Mavic 3 Enterprise (wide, 20 MP)',
      sensorW: 17.3, sensorH: 13.0, focal: 12.29, pxW: 5280, pxH: 3956, minInterval: 0.7,
      shutter: 'mechanical', wpml: { drone: 77, droneSub: 0, payload: 66 },
      note: '4/3 CMOS, 24 mm equivalent, mechanical shutter, 0.7 s interval. RTK module optional.' },
    { id: 'm3m', name: 'DJI Mavic 3 Multispectral (RGB, 20 MP)',
      sensorW: 17.3, sensorH: 13.0, focal: 12.29, pxW: 5280, pxH: 3956, minInterval: 0.7,
      shutter: 'mechanical', wpml: { drone: 77, droneSub: 2, payload: 68 },
      note: 'Same 4/3 RGB camera as the M3E. The four 5 MP multispectral bands have a narrower, 73.9° FOV.' },
    { id: 'm3m-ms', name: 'DJI Mavic 3 Multispectral (one MS band, 5 MP)',
      sensorW: 5.6, sensorH: 4.2, focal: 4.34, pxW: 2592, pxH: 1944, minInterval: 0.7,
      shutter: 'global', verify: true, wpml: { drone: 77, droneSub: 2, payload: 68 },
      note: '1/2.8" CMOS global shutter, 25 mm equivalent. Sensor dimensions estimated from the format; verify.' },
    { id: 'm4e', name: 'DJI Matrice 4E (wide, 20 MP)',
      sensorW: 17.3, sensorH: 13.0, focal: 12.29, pxW: 5280, pxH: 3956, minInterval: 0.7,
      shutter: 'mechanical', verify: true, wpml: { drone: 99, droneSub: 0, payload: 88 },
      note: '4/3 CMOS, 24 mm equivalent, mechanical shutter. DJI quotes a faster interval than the M3E; 0.7 s kept as a conservative default. Verify.' },
    { id: 'm4t', name: 'DJI Matrice 4T (wide, 48 MP)',
      sensorW: 9.6, sensorH: 7.2, focal: 6.72, pxW: 8064, pxH: 6048, minInterval: 0.7,
      shutter: 'electronic', verify: true, wpml: { drone: 99, droneSub: 1, payload: 89 },
      note: '1/1.3" CMOS, 24 mm equivalent, electronic shutter only (rolling-shutter risk at speed). Dimensions and focal estimated; verify.' },
    { id: 'p4rtk', name: 'DJI Phantom 4 RTK (20 MP)',
      sensorW: 13.2, sensorH: 8.8, focal: 8.8, pxW: 5472, pxH: 3648, minInterval: 2.0,
      shutter: 'mechanical', verify: true, wpml: null,
      note: '1" CMOS, 24 mm equivalent, mechanical shutter. Minimum interval of about 2 s in GS RTK; verify. Plans in GS RTK, not WPML.' },
    { id: 'm4pro', name: 'DJI Mavic 4 Pro (Hasselblad wide, 100 MP)',
      sensorW: 17.3, sensorH: 13.0, focal: 14.3, pxW: 11648, pxH: 8736, minInterval: 2.0,
      shutter: 'electronic', verify: true, wpml: null,
      note: '4/3 CMOS, 28 mm equivalent, no mechanical shutter, no WPML import in DJI Fly. Focal and interval estimated; verify.' },
    { id: 'custom', name: 'Custom camera',
      sensorW: 17.3, sensorH: 13.0, focal: 12.29, pxW: 5280, pxH: 3956, minInterval: 0.7,
      shutter: 'mechanical', wpml: { drone: 77, droneSub: 0, payload: 66 },
      note: 'Enter your own sensor width/height, focal length and pixel counts.' }
  ];

  function cameraById(id) {
    for (var i = 0; i < CAMERAS.length; i++) if (CAMERAS[i].id === id) return CAMERAS[i];
    return null;
  }

  /* ---------------- Core photogrammetry maths ---------------- */
  function gsdFromAltitude(cam, altM) {
    // cm/px. GSD = sensorWidth * altitude / (focal * imageWidth)
    return (cam.sensorW * altM * 100) / (cam.focal * cam.pxW);
  }
  function altitudeFromGsd(cam, gsdCm) {
    return (gsdCm * cam.focal * cam.pxW) / (cam.sensorW * 100);
  }
  function footprint(cam, altM) {
    // Ground footprint of one frame at nadir, metres. w is the sensor's long side.
    return { w: cam.sensorW * altM / cam.focal, h: cam.sensorH * altM / cam.focal };
  }
  function lineSpacing(footprintW, sideOverlap) { return footprintW * (1 - sideOverlap); }
  function photoInterval(footprintH, frontOverlap) { return footprintH * (1 - frontOverlap); }
  function fov(cam) {
    return {
      h: 2 * Math.atan(cam.sensorW / (2 * cam.focal)) / DEG,
      v: 2 * Math.atan(cam.sensorH / (2 * cam.focal)) / DEG
    };
  }
  function maxSpeedForShutter(intervalM, minIntervalS) {
    return minIntervalS > 0 ? intervalM / minIntervalS : Infinity;
  }
  function motionBlurCm(speedMs, exposureS) { return speedMs * exposureS * 100; }

  /* ---------------- Local tangent-plane frame ----------------
     Equirectangular projection about an origin. Error is negligible for sites under a few km. */
  function makeFrame(lat0, lon0) {
    var k = Math.cos(lat0 * DEG);
    return {
      lat0: lat0, lon0: lon0,
      toXY: function (lat, lon) {
        return { x: (lon - lon0) * DEG * R_EARTH * k, y: (lat - lat0) * DEG * R_EARTH };
      },
      toLL: function (x, y) {
        return { lat: lat0 + y / R_EARTH / DEG, lon: lon0 + x / (R_EARTH * k) / DEG };
      }
    };
  }
  function frameForPolygon(polyLL) {
    var lat = 0, lon = 0;
    for (var i = 0; i < polyLL.length; i++) { lat += polyLL[i].lat; lon += polyLL[i].lon; }
    return makeFrame(lat / polyLL.length, lon / polyLL.length);
  }
  function dist(a, b) { var dx = a.x - b.x, dy = a.y - b.y; return Math.sqrt(dx * dx + dy * dy); }
  function headingDeg(a, b) { return ((Math.atan2(b.x - a.x, b.y - a.y) / DEG) + 360) % 360; }
  function haversine(lat1, lon1, lat2, lon2) {
    var dLat = (lat2 - lat1) * DEG, dLon = (lon2 - lon1) * DEG;
    var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R_EARTH * Math.asin(Math.sqrt(s));
  }

  /* ---------------- Polygon helpers (XY) ---------------- */
  function polygonArea(poly) {
    var a = 0;
    for (var i = 0, n = poly.length; i < n; i++) {
      var p = poly[i], q = poly[(i + 1) % n];
      a += p.x * q.y - q.x * p.y;
    }
    return Math.abs(a) / 2;
  }
  function pointInPolygon(pt, poly) {
    var inside = false;
    for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      var pi = poly[i], pj = poly[j];
      var intersect = ((pi.y > pt.y) !== (pj.y > pt.y)) &&
        (pt.x < (pj.x - pi.x) * (pt.y - pi.y) / (pj.y - pi.y) + pi.x);
      if (intersect) inside = !inside;
    }
    return inside;
  }
  function longestEdgeHeading(poly) {
    var best = 0, bestLen = -1;
    for (var i = 0, n = poly.length; i < n; i++) {
      var p = poly[i], q = poly[(i + 1) % n], L = dist(p, q);
      if (L > bestLen) { bestLen = L; best = headingDeg(p, q); }
    }
    return best % 180;
  }

  /* Clip the infinite line  P(t) = n*s + d*t  against the polygon.
     Returns segments [{a,b}] ordered along +d. Handles concave shapes (multiple segments). */
  function clipLineToPolygon(poly, n, d, s) {
    var ts = [];
    for (var i = 0, m = poly.length; i < m; i++) {
      var p = poly[i], q = poly[(i + 1) % m];
      var fp = p.x * n.x + p.y * n.y - s;
      var fq = q.x * n.x + q.y * n.y - s;
      if ((fp > 0 && fq > 0) || (fp < 0 && fq < 0)) continue;   // both on one side
      if (fp === fq) continue;                                   // edge parallel and on the line; skip
      var u = fp / (fp - fq);
      if (u < 0 || u >= 1) continue;                             // count each vertex hit once
      var x = p.x + (q.x - p.x) * u, y = p.y + (q.y - p.y) * u;
      ts.push(x * d.x + y * d.y);
    }
    ts.sort(function (a, b) { return a - b; });
    // Remove near-duplicate crossings produced by hitting a vertex exactly.
    var clean = [];
    for (var k = 0; k < ts.length; k++) {
      if (clean.length === 0 || Math.abs(ts[k] - clean[clean.length - 1]) > 1e-6) clean.push(ts[k]);
    }
    var segs = [];
    for (var j = 0; j + 1 < clean.length; j += 2) {
      var t0 = clean[j], t1 = clean[j + 1];
      // Verify the midpoint is really inside (guards against tangent vertex hits).
      var mid = { x: n.x * s + d.x * (t0 + t1) / 2, y: n.y * s + d.y * (t0 + t1) / 2 };
      if (!pointInPolygon(mid, poly)) { j -= 1; continue; }
      if (t1 - t0 < 0.5) continue;
      segs.push({ a: { x: n.x * s + d.x * t0, y: n.y * s + d.y * t0 },
                  b: { x: n.x * s + d.x * t1, y: n.y * s + d.y * t1 } });
    }
    return segs;
  }

  /* Generate parallel flight lines over a polygon.
     spacing: between lines, footprintW: across-track footprint so edges are covered.
     Returns [{s, segments:[{a,b}]}] with lines ordered across track. */
  function gridLines(poly, spacing, headingDegrees, footprintW) {
    var th = headingDegrees * DEG;
    var d = { x: Math.sin(th), y: Math.cos(th) };          // along-track unit vector
    var n = { x: Math.cos(th), y: -Math.sin(th) };         // across-track unit vector
    var smin = Infinity, smax = -Infinity;
    for (var i = 0; i < poly.length; i++) {
      var s = poly[i].x * n.x + poly[i].y * n.y;
      if (s < smin) smin = s;
      if (s > smax) smax = s;
    }
    var W = smax - smin;
    var fw = footprintW || 0;
    var count = Math.max(1, Math.ceil((W - fw) / spacing - 1e-9) + 1);
    var span = (count - 1) * spacing;
    var s0 = (smin + smax) / 2 - span / 2;
    var lines = [];
    for (var k = 0; k < count; k++) {
      var sk = s0 + k * spacing;
      // Lines centred exactly on a polygon edge yield nothing; nudge inside by a few cm.
      if (Math.abs(sk - smin) < 1e-6) sk = smin + 0.05;
      if (Math.abs(sk - smax) < 1e-6) sk = smax - 0.05;
      var segs = clipLineToPolygon(poly, n, d, sk);
      if (segs.length) lines.push({ s: sk, segments: segs });
    }
    return lines;
  }

  /* Distribute photo stations evenly along a segment so that spacing <= interval
     and both ends get a photo. */
  function photosAlongSegment(a, b, interval) {
    var L = dist(a, b);
    var n = Math.max(1, Math.ceil(L / interval - 1e-9));
    var pts = [];
    for (var k = 0; k <= n; k++) {
      var f = k / n;
      pts.push({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f });
    }
    return pts;
  }

  /* ---------------- Nadir grid / double grid plan ---------------- */
  function planGrid(polyLL, cam, p) {
    // p: altitude, frontOverlap, sideOverlap, heading, speed, doubleGrid,
    //    turnTime (s per line), climbRate (m/s), usableBatteryMin
    var frame = frameForPolygon(polyLL);
    var poly = polyLL.map(function (q) { return frame.toXY(q.lat, q.lon); });
    var alt = p.altitude;
    var fp = footprint(cam, alt);
    var spacing = lineSpacing(fp.w, p.sideOverlap);
    var interval = photoInterval(fp.h, p.frontOverlap);
    var headings = p.doubleGrid ? [p.heading, p.heading + 90] : [p.heading];

    var waypoints = [], photos = [], lineCount = 0, segCount = 0, last = null;
    headings.forEach(function (h, passIdx) {
      var lines = gridLines(poly, spacing, h, fp.w);
      lines.forEach(function (line, li) {
        var segs = line.segments.slice();
        // Choose the direction of travel that starts nearest to where we are.
        var fwdStart = segs[0].a, revStart = segs[segs.length - 1].b;
        var reverse = last ? dist(last, revStart) < dist(last, fwdStart) : (li % 2 === 1);
        if (reverse) {
          segs = segs.slice().reverse().map(function (sg) { return { a: sg.b, b: sg.a }; });
        }
        lineCount++;
        segs.forEach(function (sg) {
          var hd = headingDeg(sg.a, sg.b);
          var stations = photosAlongSegment(sg.a, sg.b, interval);
          var segPhotos = stations.map(function (pt, k) {
            var ll = frame.toLL(pt.x, pt.y);
            return { x: pt.x, y: pt.y, lat: ll.lat, lon: ll.lon, alt: alt, heading: hd, pitch: -90,
                     line: lineCount, pass: passIdx + 1, index: photos.length + k };
          });
          photos = photos.concat(segPhotos);
          var la = frame.toLL(sg.a.x, sg.a.y), lb = frame.toLL(sg.b.x, sg.b.y);
          waypoints.push({ x: sg.a.x, y: sg.a.y, lat: la.lat, lon: la.lon, alt: alt, heading: hd, pitch: -90,
                           role: 'segStart', interval: interval, line: lineCount, photos: segPhotos.length });
          waypoints.push({ x: sg.b.x, y: sg.b.y, lat: lb.lat, lon: lb.lon, alt: alt, heading: hd, pitch: -90,
                           role: 'segEnd', line: lineCount });
          segCount++;
          last = sg.b;
        });
      });
    });

    var routeLen = 0;
    for (var i = 1; i < waypoints.length; i++) routeLen += dist(waypoints[i - 1], waypoints[i]);
    var climbRate = p.climbRate || 3;
    var turnTime = (p.turnTime == null) ? 6 : p.turnTime;
    var timeS = routeLen / p.speed + lineCount * turnTime + 2 * alt / climbRate;
    var usable = p.usableBatteryMin || 22;

    var plan = {
      type: p.doubleGrid ? 'double' : 'nadir',
      cam: cam, frame: frame, polyXY: poly, polyLL: polyLL,
      altitude: alt, gsd: gsdFromAltitude(cam, alt), footprint: fp,
      spacing: spacing, interval: interval, intervalS: interval / p.speed,
      speed: p.speed, lineCount: lineCount, segmentCount: segCount,
      photos: photos, waypoints: waypoints,
      routeLen: routeLen, timeS: timeS, batteries: Math.max(1, Math.ceil(timeS / 60 / usable)),
      areaM2: polygonArea(poly), maxSpeed: maxSpeedForShutter(interval, cam.minInterval)
    };
    plan.warnings = evaluateWarnings(plan);
    return plan;
  }

  /* ---------------- Oblique "splat ring" plan ----------------
     Concentric orbits around a point of interest at several altitude tiers. Each tier has an
     altitude AGL and a gimbal pitch; the radius follows from aiming the camera at the POI
     at height poiHeight. Photos per ring come from the across-track footprint at slant range
     and the requested overlap, with a floor so small rings are never undersampled. */
  function ringTier(cam, tier, poiHeight, overlap, minPhotos, maxStepDeg) {
    var pitch = Math.abs(tier.pitch);
    var dz = tier.alt - poiHeight;
    var out = { alt: tier.alt, pitch: -pitch, dz: dz };
    if (dz <= 0 || pitch <= 0 || pitch >= 90) { out.invalid = true; out.radius = 0; out.slant = 0; out.gsd = NaN; out.n = 0; out.stepDeg = NaN; return out; }
    var r = dz / Math.tan(pitch * DEG);
    var slant = dz / Math.sin(pitch * DEG);
    var fw = cam.sensorW * slant / cam.focal;              // long side, tangential to the orbit
    var step = fw * (1 - overlap);
    var n = Math.ceil(2 * Math.PI * r / step - 1e-9);
    n = Math.max(n, minPhotos || 12, Math.ceil(360 / (maxStepDeg || 15)));
    out.radius = r; out.slant = slant;
    out.gsd = (cam.sensorW * slant * 100) / (cam.focal * cam.pxW);  // at the frame centre
    out.footprintW = fw; out.n = n; out.stepDeg = 360 / n; out.circumference = 2 * Math.PI * r;
    return out;
  }

  function planRing(poiLL, cam, p) {
    // p: tiers [{alt,pitch}], poiHeight, frontOverlap, speed, minPhotos, maxStepDeg,
    //    dwellTime (s per waypoint), climbRate, usableBatteryMin
    var frame = makeFrame(poiLL.lat, poiLL.lon);
    var photos = [], tiers = [], routeLen = 0, last = null, maxAlt = 0;
    p.tiers.forEach(function (t, ti) {
      var tier = ringTier(cam, t, p.poiHeight || 0, p.frontOverlap, p.minPhotos, p.maxStepDeg);
      tier.index = ti + 1;
      tiers.push(tier);
      if (tier.invalid) return;
      if (tier.alt > maxAlt) maxAlt = tier.alt;
      var cw = ti % 2 === 0;                               // alternate direction per tier
      for (var k = 0; k < tier.n; k++) {
        var ang = (cw ? k : -k) * 2 * Math.PI / tier.n;
        var x = tier.radius * Math.sin(ang), y = tier.radius * Math.cos(ang);
        var ll = frame.toLL(x, y);
        var pt = { x: x, y: y, lat: ll.lat, lon: ll.lon, alt: tier.alt,
                   heading: ((ang / DEG) + 180 + 360) % 360,          // face the centre
                   pitch: tier.pitch, tier: tier.index, index: photos.length };
        if (last) routeLen += dist(last, pt) + Math.abs(pt.alt - last.alt);
        photos.push(pt);
        last = pt;
      }
      // closing leg back toward the first point of the ring is not flown; next tier starts here
    });
    var dwell = (p.dwellTime == null) ? 2 : p.dwellTime;
    var climbRate = p.climbRate || 3;
    var timeS = routeLen / p.speed + photos.length * dwell + 2 * maxAlt / climbRate;
    var usable = p.usableBatteryMin || 22;
    var minStep = Infinity;
    tiers.forEach(function (t) { if (!t.invalid && t.circumference / t.n < minStep) minStep = t.circumference / t.n; });

    var plan = {
      type: 'ring', cam: cam, frame: frame, poi: poiLL, poiHeight: p.poiHeight || 0,
      tiers: tiers, photos: photos, waypoints: photos, speed: p.speed,
      interval: minStep, intervalS: minStep / p.speed,
      routeLen: routeLen, timeS: timeS, batteries: Math.max(1, Math.ceil(timeS / 60 / usable)),
      altitude: maxAlt, maxSpeed: maxSpeedForShutter(minStep, cam.minInterval)
    };
    plan.gsd = tiers.length ? Math.max.apply(null, tiers.filter(function (t) { return !t.invalid; }).map(function (t) { return t.gsd; })) : NaN;
    plan.warnings = evaluateWarnings(plan);
    return plan;
  }

  /* ---------------- Warnings ---------------- */
  function evaluateWarnings(plan) {
    var w = [], cam = plan.cam;
    if (plan.altitude > PART107_LIMIT_M + 1e-6) {
      w.push({ level: 'error', text: 'Altitude ' + plan.altitude.toFixed(0) + ' m (' + (plan.altitude * FT_PER_M).toFixed(0) +
        ' ft) exceeds the Part 107 ceiling of 400 ft AGL. Lower the altitude or accept a coarser GSD. The 400 ft-above-structure allowance applies only within 400 ft of a structure you are inspecting.' });
    }
    if (plan.type === 'ring') {
      plan.tiers.forEach(function (t) {
        if (t.invalid) w.push({ level: 'error', text: 'Tier ' + t.index + ': altitude must be above the POI height and pitch between -1° and -89°.' });
      });
    }
    if (isFinite(plan.intervalS) && plan.intervalS < cam.minInterval) {
      w.push({ level: 'error', text: 'Photo interval ' + plan.intervalS.toFixed(2) + ' s is shorter than the camera minimum of ' + cam.minInterval +
        ' s. Slow to ' + plan.maxSpeed.toFixed(1) + ' m/s or fly higher. The aircraft will skip frames otherwise, and overlap collapses.' });
    } else if (isFinite(plan.intervalS) && plan.intervalS < cam.minInterval * 1.3) {
      w.push({ level: 'warn', text: 'Photo interval ' + plan.intervalS.toFixed(2) + ' s is close to the camera minimum (' + cam.minInterval + ' s). Little margin for write-speed hiccups.' });
    }
    if (cam.shutter === 'electronic' && plan.speed > 8) {
      w.push({ level: 'warn', text: 'Electronic (rolling) shutter above 8 m/s: expect skew on nadir frames. Slow down or accept it in the bundle adjustment.' });
    }
    if (plan.type !== 'ring' && plan.photos.length > 1500) {
      w.push({ level: 'warn', text: plan.photos.length + ' photos. Consider splitting the area; a single very large block is harder to QA and reflies cost a whole battery.' });
    }
    if (plan.type !== 'ring' && plan.batteries > 4) {
      w.push({ level: 'warn', text: plan.batteries + ' batteries estimated. Light changes across that long a window; plan for consistent exposure or split across days at the same hour.' });
    }
    return w;
  }

  /* ---------------- Import: KML / GeoJSON polygon ---------------- */
  function parsePolygonText(text) {
    var t = text.trim();
    if (t[0] === '{' || t[0] === '[') return parseGeoJSONPolygon(JSON.parse(t));
    return parseKMLPolygon(t);
  }
  function parseGeoJSONPolygon(gj) {
    var geom = null;
    function fromGeom(g) {
      if (!g) return null;
      if (g.type === 'Polygon') return g.coordinates[0];
      if (g.type === 'MultiPolygon') return g.coordinates[0][0];
      if (g.type === 'GeometryCollection') { for (var i = 0; i < g.geometries.length; i++) { var r = fromGeom(g.geometries[i]); if (r) return r; } }
      return null;
    }
    if (gj.type === 'FeatureCollection') {
      for (var i = 0; i < gj.features.length && !geom; i++) geom = fromGeom(gj.features[i].geometry);
    } else if (gj.type === 'Feature') geom = fromGeom(gj.geometry);
    else geom = fromGeom(gj);
    if (!geom) throw new Error('No Polygon found in GeoJSON');
    return ringToLL(geom.map(function (c) { return { lon: c[0], lat: c[1] }; }));
  }
  function parseKMLPolygon(xmlText) {
    var doc = new DOMParser().parseFromString(xmlText, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('KML did not parse');
    var polys = doc.getElementsByTagName('Polygon');
    if (!polys.length) throw new Error('No Polygon in KML');
    var outer = polys[0].getElementsByTagName('outerBoundaryIs')[0] || polys[0];
    var coords = outer.getElementsByTagName('coordinates')[0];
    if (!coords) throw new Error('Polygon has no coordinates');
    var pts = coords.textContent.trim().split(/\s+/).map(function (tok) {
      var c = tok.split(',').map(parseFloat);
      return { lon: c[0], lat: c[1] };
    }).filter(function (p) { return isFinite(p.lat) && isFinite(p.lon); });
    return ringToLL(pts);
  }
  function ringToLL(pts) {
    if (pts.length > 1) {
      var f = pts[0], l = pts[pts.length - 1];
      if (Math.abs(f.lat - l.lat) < 1e-9 && Math.abs(f.lon - l.lon) < 1e-9) pts = pts.slice(0, -1);
    }
    if (pts.length < 3) throw new Error('Polygon needs at least 3 vertices');
    return pts;
  }

  /* ---------------- Exports ---------------- */
  function xmlEscape(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function f6(v) { return v.toFixed(6); }
  function f1(v) { return v.toFixed(1); }

  function buildKML(plan, name) {
    var out = ['<?xml version="1.0" encoding="UTF-8"?>',
      '<kml xmlns="http://www.opengis.net/kml/2.2"><Document>',
      '<name>' + xmlEscape(name || 'Capture plan') + '</name>',
      '<Style id="area"><LineStyle><color>ff2b4a7a</color><width>2</width></LineStyle><PolyStyle><color>332b4a7a</color></PolyStyle></Style>',
      '<Style id="route"><LineStyle><color>ffffffff</color><width>2</width></LineStyle></Style>',
      '<Style id="photo"><IconStyle><scale>0.4</scale><Icon><href>http://maps.google.com/mapfiles/kml/shapes/placemark_circle.png</href></Icon></IconStyle><LabelStyle><scale>0</scale></LabelStyle></Style>'];
    if (plan.polyLL) {
      var ring = plan.polyLL.concat([plan.polyLL[0]]).map(function (p) { return f6(p.lon) + ',' + f6(p.lat) + ',0'; }).join(' ');
      out.push('<Placemark><name>Survey area</name><styleUrl>#area</styleUrl><Polygon><tessellate>1</tessellate><outerBoundaryIs><LinearRing><coordinates>' + ring + '</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>');
    }
    if (plan.poi) {
      out.push('<Placemark><name>Point of interest</name><Point><coordinates>' + f6(plan.poi.lon) + ',' + f6(plan.poi.lat) + ',0</coordinates></Point></Placemark>');
    }
    var route = plan.waypoints.map(function (w) { return f6(w.lon) + ',' + f6(w.lat) + ',' + f1(w.alt); }).join(' ');
    out.push('<Placemark><name>Flight route</name><styleUrl>#route</styleUrl><LineString><tessellate>1</tessellate><altitudeMode>relativeToGround</altitudeMode><coordinates>' + route + '</coordinates></LineString></Placemark>');
    out.push('<Folder><name>Photo stations (' + plan.photos.length + ')</name>');
    plan.photos.forEach(function (ph, i) {
      out.push('<Placemark><name>' + (i + 1) + '</name><styleUrl>#photo</styleUrl><description>alt ' + f1(ph.alt) + ' m AGL, heading ' + ph.heading.toFixed(0) + '°, pitch ' + ph.pitch.toFixed(0) + '°</description>' +
        '<Point><altitudeMode>relativeToGround</altitudeMode><coordinates>' + f6(ph.lon) + ',' + f6(ph.lat) + ',' + f1(ph.alt) + '</coordinates></Point></Placemark>');
    });
    out.push('</Folder></Document></kml>');
    return out.join('\n');
  }

  function buildCSV(plan) {
    var rows = ['index,latitude,longitude,altitude_agl_m,heading_deg,gimbal_pitch_deg,group'];
    plan.photos.forEach(function (p, i) {
      rows.push([i + 1, f6(p.lat), f6(p.lon), f1(p.alt), p.heading.toFixed(1), p.pitch.toFixed(1),
        p.tier != null ? 'tier' + p.tier : 'line' + p.line].join(','));
    });
    return rows.join('\n');
  }

  /* DJI WPML (WPMZ) — template.kml + waylines.wpml, both inside wpmz/ in the KMZ.
     Follows the public WPML spec (namespace wpmz/1.0.2). DJI Pilot 2 recomputes the template
     when importing, so waylines.wpml is what actually flies. Review in Pilot 2 before flight.
     opts: author, drone {drone, droneSub, payload}, mode 'perPhoto'|'lineEnds',
           rthHeight, takeoffSecurityHeight, transitionalSpeed */
  function buildWPML(plan, opts) {
    opts = opts || {};
    var now = Date.now();
    var drone = opts.drone || plan.cam.wpml || { drone: 77, droneSub: 0, payload: 66 };
    var speed = plan.speed;
    var ring = plan.type === 'ring';
    var mode = ring ? 'perPhoto' : (opts.mode || 'lineEnds');
    var rth = opts.rthHeight != null ? opts.rthHeight : Math.max(100, Math.ceil(plan.altitude + 20));
    var missionConfig =
      '  <wpml:missionConfig>\n' +
      '    <wpml:flyToWaylineMode>safely</wpml:flyToWaylineMode>\n' +
      '    <wpml:finishAction>goHome</wpml:finishAction>\n' +
      '    <wpml:exitOnRCLost>executeLostAction</wpml:exitOnRCLost>\n' +
      '    <wpml:executeRCLostAction>goBack</wpml:executeRCLostAction>\n' +
      '    <wpml:takeOffSecurityHeight>' + (opts.takeoffSecurityHeight != null ? opts.takeoffSecurityHeight : 20) + '</wpml:takeOffSecurityHeight>\n' +
      '    <wpml:globalTransitionalSpeed>' + (opts.transitionalSpeed != null ? opts.transitionalSpeed : 10) + '</wpml:globalTransitionalSpeed>\n' +
      '    <wpml:globalRTHHeight>' + rth + '</wpml:globalRTHHeight>\n' +
      '    <wpml:droneInfo>\n' +
      '      <wpml:droneEnumValue>' + drone.drone + '</wpml:droneEnumValue>\n' +
      '      <wpml:droneSubEnumValue>' + drone.droneSub + '</wpml:droneSubEnumValue>\n' +
      '    </wpml:droneInfo>\n' +
      '    <wpml:payloadInfo>\n' +
      '      <wpml:payloadEnumValue>' + drone.payload + '</wpml:payloadEnumValue>\n' +
      '      <wpml:payloadSubEnumValue>0</wpml:payloadSubEnumValue>\n' +
      '      <wpml:payloadPositionIndex>0</wpml:payloadPositionIndex>\n' +
      '    </wpml:payloadInfo>\n' +
      '  </wpml:missionConfig>\n';

    var poiStr = ring ? (f6(plan.poi.lat) + ',' + f6(plan.poi.lon) + ',' + f6(plan.poiHeight || 0)) : '0.000000,0.000000,0.000000';
    var headingMode = ring ? 'towardPOI' : 'followWayline';
    var turnMode = 'toPointAndStopWithDiscontinuityCurvature';

    // Waypoint list
    var wps = mode === 'perPhoto' ? plan.photos : plan.waypoints;

    function headingParam(indent, wp) {
      var ang = ring ? 0 : Math.round(wp.heading);
      return indent + '<wpml:waypointHeadingMode>' + headingMode + '</wpml:waypointHeadingMode>\n' +
        indent + '<wpml:waypointHeadingAngle>' + ang + '</wpml:waypointHeadingAngle>\n' +
        indent + '<wpml:waypointPoiPoint>' + poiStr + '</wpml:waypointPoiPoint>\n' +
        indent + '<wpml:waypointHeadingAngleEnable>0</wpml:waypointHeadingAngleEnable>\n' +
        indent + '<wpml:waypointHeadingPathMode>followBadArc</wpml:waypointHeadingPathMode>\n';
    }
    function gimbalAction(id, pitch) {
      return '        <wpml:action>\n' +
        '          <wpml:actionId>' + id + '</wpml:actionId>\n' +
        '          <wpml:actionActuatorFunc>gimbalRotate</wpml:actionActuatorFunc>\n' +
        '          <wpml:actionActuatorFuncParam>\n' +
        '            <wpml:gimbalRotateMode>absoluteAngle</wpml:gimbalRotateMode>\n' +
        '            <wpml:gimbalPitchRotateEnable>1</wpml:gimbalPitchRotateEnable>\n' +
        '            <wpml:gimbalPitchRotateAngle>' + pitch.toFixed(1) + '</wpml:gimbalPitchRotateAngle>\n' +
        '            <wpml:gimbalRollRotateEnable>0</wpml:gimbalRollRotateEnable>\n' +
        '            <wpml:gimbalRollRotateAngle>0</wpml:gimbalRollRotateAngle>\n' +
        '            <wpml:gimbalYawRotateEnable>0</wpml:gimbalYawRotateEnable>\n' +
        '            <wpml:gimbalYawRotateAngle>0</wpml:gimbalYawRotateAngle>\n' +
        '            <wpml:gimbalRotateTimeEnable>0</wpml:gimbalRotateTimeEnable>\n' +
        '            <wpml:gimbalRotateTime>0</wpml:gimbalRotateTime>\n' +
        '            <wpml:payloadPositionIndex>0</wpml:payloadPositionIndex>\n' +
        '          </wpml:actionActuatorFuncParam>\n' +
        '        </wpml:action>\n';
    }
    function photoAction(id) {
      return '        <wpml:action>\n' +
        '          <wpml:actionId>' + id + '</wpml:actionId>\n' +
        '          <wpml:actionActuatorFunc>takePhoto</wpml:actionActuatorFunc>\n' +
        '          <wpml:actionActuatorFuncParam>\n' +
        '            <wpml:payloadPositionIndex>0</wpml:payloadPositionIndex>\n' +
        '            <wpml:useGlobalPayloadLensIndex>1</wpml:useGlobalPayloadLensIndex>\n' +
        '          </wpml:actionActuatorFuncParam>\n' +
        '        </wpml:action>\n';
    }
    function actionGroup(gid, start, end, trigger, param, actions) {
      return '      <wpml:actionGroup>\n' +
        '        <wpml:actionGroupId>' + gid + '</wpml:actionGroupId>\n' +
        '        <wpml:actionGroupStartIndex>' + start + '</wpml:actionGroupStartIndex>\n' +
        '        <wpml:actionGroupEndIndex>' + end + '</wpml:actionGroupEndIndex>\n' +
        '        <wpml:actionGroupMode>sequence</wpml:actionGroupMode>\n' +
        '        <wpml:actionTrigger>\n' +
        '          <wpml:actionTriggerType>' + trigger + '</wpml:actionTriggerType>\n' +
        (param != null ? '          <wpml:actionTriggerParam>' + param + '</wpml:actionTriggerParam>\n' : '') +
        '        </wpml:actionTrigger>\n' +
        actions +
        '      </wpml:actionGroup>\n';
    }

    // Build action groups per waypoint index
    var groups = {};   // index -> [xml]
    var gid = 0;
    function addGroup(i, xml) { (groups[i] = groups[i] || []).push(xml); }
    if (mode === 'perPhoto') {
      var lastPitch = null;
      wps.forEach(function (wp, i) {
        var acts = '';
        var aid = 0;
        if (lastPitch === null || Math.abs(wp.pitch - lastPitch) > 0.05) { acts += gimbalAction(aid++, wp.pitch); lastPitch = wp.pitch; }
        acts += photoAction(aid++);
        addGroup(i, actionGroup(gid++, i, i, 'reachPoint', null, acts));
      });
    } else {
      // Line-end waypoints: gimbal once, then a distance-triggered photo group per segment.
      addGroup(0, actionGroup(gid++, 0, 0, 'reachPoint', null, gimbalAction(0, -90)));
      for (var i = 0; i + 1 < wps.length; i += 2) {
        // photo at the segment start, then every interval metres until the segment end
        addGroup(i, actionGroup(gid++, i, i, 'reachPoint', null, photoAction(0)));
        addGroup(i, actionGroup(gid++, i, i + 1, 'multipleDistance', wps[i].interval.toFixed(2), photoAction(0)));
      }
    }

    // ---- template.kml ----
    var t = [];
    t.push('<?xml version="1.0" encoding="UTF-8"?>');
    t.push('<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:wpml="http://www.dji.com/wpmz/1.0.2">');
    t.push('<Document>');
    t.push('  <wpml:author>' + xmlEscape(opts.author || 'capture-planner') + '</wpml:author>');
    t.push('  <wpml:createTime>' + now + '</wpml:createTime>');
    t.push('  <wpml:updateTime>' + now + '</wpml:updateTime>');
    t.push(missionConfig.replace(/\n$/, ''));
    t.push('  <Folder>');
    t.push('    <wpml:templateType>waypoint</wpml:templateType>');
    t.push('    <wpml:templateId>0</wpml:templateId>');
    t.push('    <wpml:waylineCoordinateSysParam>');
    t.push('      <wpml:coordinateMode>WGS84</wpml:coordinateMode>');
    t.push('      <wpml:heightMode>relativeToStartPoint</wpml:heightMode>');
    t.push('      <wpml:positioningType>' + (opts.rtk ? 'RTKBaseStation' : 'GPS') + '</wpml:positioningType>');
    t.push('    </wpml:waylineCoordinateSysParam>');
    t.push('    <wpml:autoFlightSpeed>' + f1(speed) + '</wpml:autoFlightSpeed>');
    t.push('    <wpml:globalHeight>' + f1(plan.altitude) + '</wpml:globalHeight>');
    t.push('    <wpml:caliFlightEnable>0</wpml:caliFlightEnable>');
    t.push('    <wpml:gimbalPitchMode>usePointSetting</wpml:gimbalPitchMode>');
    t.push('    <wpml:globalWaypointHeadingParam>');
    t.push(headingParam('      ', wps[0] || { heading: 0 }).replace(/\n$/, ''));
    t.push('    </wpml:globalWaypointHeadingParam>');
    t.push('    <wpml:globalWaypointTurnMode>' + turnMode + '</wpml:globalWaypointTurnMode>');
    t.push('    <wpml:globalUseStraightLine>1</wpml:globalUseStraightLine>');
    t.push('    <wpml:payloadParam>');
    t.push('      <wpml:payloadPositionIndex>0</wpml:payloadPositionIndex>');
    t.push('      <wpml:focusMode>firstPoint</wpml:focusMode>');
    t.push('      <wpml:meteringMode>average</wpml:meteringMode>');
    t.push('      <wpml:dewarpingEnable>0</wpml:dewarpingEnable>');
    t.push('      <wpml:imageFormat>wide</wpml:imageFormat>');
    t.push('    </wpml:payloadParam>');
    wps.forEach(function (wp, i) {
      t.push('    <Placemark>');
      t.push('      <Point><coordinates>' + f6(wp.lon) + ',' + f6(wp.lat) + '</coordinates></Point>');
      t.push('      <wpml:index>' + i + '</wpml:index>');
      t.push('      <wpml:ellipsoidHeight>' + f1(wp.alt) + '</wpml:ellipsoidHeight>');
      t.push('      <wpml:height>' + f1(wp.alt) + '</wpml:height>');
      t.push('      <wpml:useGlobalHeight>' + (Math.abs(wp.alt - plan.altitude) < 0.05 ? 1 : 0) + '</wpml:useGlobalHeight>');
      t.push('      <wpml:useGlobalSpeed>1</wpml:useGlobalSpeed>');
      t.push('      <wpml:useGlobalHeadingParam>' + (ring ? 1 : 0) + '</wpml:useGlobalHeadingParam>');
      if (!ring) { t.push('      <wpml:waypointHeadingParam>'); t.push(headingParam('        ', wp).replace(/\n$/, '')); t.push('      </wpml:waypointHeadingParam>'); }
      t.push('      <wpml:useGlobalTurnParam>1</wpml:useGlobalTurnParam>');
      t.push('      <wpml:useStraightLine>1</wpml:useStraightLine>');
      t.push('      <wpml:gimbalPitchAngle>' + wp.pitch.toFixed(1) + '</wpml:gimbalPitchAngle>');
      (groups[i] || []).forEach(function (g) { t.push(g.replace(/\n$/, '')); });
      t.push('    </Placemark>');
    });
    t.push('  </Folder>');
    t.push('</Document>');
    t.push('</kml>');

    // ---- waylines.wpml ----
    var w = [];
    w.push('<?xml version="1.0" encoding="UTF-8"?>');
    w.push('<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:wpml="http://www.dji.com/wpmz/1.0.2">');
    w.push('<Document>');
    w.push(missionConfig.replace(/\n$/, ''));
    w.push('  <Folder>');
    w.push('    <wpml:templateId>0</wpml:templateId>');
    w.push('    <wpml:executeHeightMode>relativeToStartPoint</wpml:executeHeightMode>');
    w.push('    <wpml:waylineId>0</wpml:waylineId>');
    w.push('    <wpml:distance>' + f1(plan.routeLen) + '</wpml:distance>');
    w.push('    <wpml:duration>' + f1(plan.timeS) + '</wpml:duration>');
    w.push('    <wpml:autoFlightSpeed>' + f1(speed) + '</wpml:autoFlightSpeed>');
    wps.forEach(function (wp, i) {
      w.push('    <Placemark>');
      w.push('      <Point><coordinates>' + f6(wp.lon) + ',' + f6(wp.lat) + '</coordinates></Point>');
      w.push('      <wpml:index>' + i + '</wpml:index>');
      w.push('      <wpml:executeHeight>' + f1(wp.alt) + '</wpml:executeHeight>');
      w.push('      <wpml:waypointSpeed>' + f1(speed) + '</wpml:waypointSpeed>');
      w.push('      <wpml:waypointHeadingParam>');
      w.push(headingParam('        ', wp).replace(/\n$/, ''));
      w.push('      </wpml:waypointHeadingParam>');
      w.push('      <wpml:waypointTurnParam>');
      w.push('        <wpml:waypointTurnMode>' + turnMode + '</wpml:waypointTurnMode>');
      w.push('        <wpml:waypointTurnDampingDist>0</wpml:waypointTurnDampingDist>');
      w.push('      </wpml:waypointTurnParam>');
      w.push('      <wpml:useStraightLine>1</wpml:useStraightLine>');
      (groups[i] || []).forEach(function (g) { w.push(g.replace(/\n$/, '')); });
      w.push('    </Placemark>');
    });
    w.push('  </Folder>');
    w.push('</Document>');
    w.push('</kml>');

    return { template: t.join('\n'), waylines: w.join('\n'), waypointCount: wps.length, mode: mode };
  }

  global.Planner = {
    DEG: DEG, R_EARTH: R_EARTH, FT_PER_M: FT_PER_M, PART107_LIMIT_M: PART107_LIMIT_M,
    CAMERAS: CAMERAS, cameraById: cameraById,
    gsdFromAltitude: gsdFromAltitude, altitudeFromGsd: altitudeFromGsd, footprint: footprint,
    lineSpacing: lineSpacing, photoInterval: photoInterval, fov: fov,
    maxSpeedForShutter: maxSpeedForShutter, motionBlurCm: motionBlurCm,
    makeFrame: makeFrame, frameForPolygon: frameForPolygon, dist: dist, headingDeg: headingDeg, haversine: haversine,
    polygonArea: polygonArea, pointInPolygon: pointInPolygon, longestEdgeHeading: longestEdgeHeading,
    clipLineToPolygon: clipLineToPolygon, gridLines: gridLines, photosAlongSegment: photosAlongSegment,
    planGrid: planGrid, ringTier: ringTier, planRing: planRing, evaluateWarnings: evaluateWarnings,
    parsePolygonText: parsePolygonText, parseGeoJSONPolygon: parseGeoJSONPolygon, parseKMLPolygon: parseKMLPolygon,
    buildKML: buildKML, buildCSV: buildCSV, buildWPML: buildWPML, xmlEscape: xmlEscape
  };
})(typeof window !== 'undefined' ? window : this);
