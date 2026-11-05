# emerlads.github.io

Personal portfolio — Roberto Bloom, Geospatial Software Engineer.

Static HTML, no build step. Pages:

- `index.html` — homepage
- `splat-to-earth/` — CesiumJS demo: a drone Gaussian splat at true lat/lon/height, checked against USGS 3DEP lidar
- `defensible-space/` — CesiumJS demo: Zone 0 / 1 / 2 screening from the same survey
- `capture-planner/` — Leaflet tool: GSD / overlap planner with KML, CSV and DJI WPML export

The demos load CesiumJS and Leaflet from public CDNs and USGS basemap tiles. Demo data is public CC0 (OpenDroneMap `odm_data_aukerman`); code and method live in [georef-splat-tools](https://github.com/Emerlads/georef-splat-tools).

Served at https://emerlads.github.io
