# Contour Map Designer

A website where customers choose an area of the British hills, frame it to a
board size, and send it as a layout for a laser-cut contour map.

**What customers do**

1. **Find their hills**: search any Wainwright, Munro, Welsh 3000, Ethel or
   Dales 30 hill, or jump to a region.
2. **Pick a board size**: A4, A3, square, coaster, custom millimetres, or the
   **305 mm clock**. A fixed frame shows exactly what will be cut; they pan and
   zoom the map underneath it. For the clock the frame is round and shows the
   numbers and hour marks, so customers can see where they land on their hills.
3. **Style it**: layered (stacked boards) or a single engraved board, the
   contour interval, smoothing, which hill lists to name, and which water to
   add: lake and reservoir shores, rivers and canals, streams and
   becks, and coastline (shown on the map as they choose; the data ships with
   the site, so nothing outside is needed).
4. **Mark a special place** (optional): up to 3 draggable markers, each with
   a shape (heart, star, pin, circle, house, cross, diamond, triangle) and
   their own label, e.g. "Where we got engaged", at 5, 8 or 12 mm. The
   request email lists each place with its coordinates.
5. **Add a hiking route** (optional): draw it by clicking on the map, or
   upload a GPX, KML or GeoJSON file. Engraved as a solid or dashed line
   (0.8, 1.2 or 2 mm). The frame moves to fit an uploaded route.
6. **Preview and send**: an interactive **3D model** of the finished piece
   (each layer at the real material thickness, in birch, oak or acrylic, with
   a centimetre ruler, overall size, stack height and map scale), a flat plan,
   a share link, and a request form. Customers cannot download the SVG; they
   send you the layout and you download it.

**What you receive**

- A **share link** that reopens the exact area and settings, so you can
  regenerate the layout yourself at any time.
- A **production SVG** at real size (mm), downloaded by you in owner mode (below):
  - one Inkscape layer per contour level (`Layer 00 base`, `Layer 01 (200 m)` …),
    and inside it **one group per separate piece** (`Piece 5A`, `Piece 5B` …),
    so you can select a whole level or pull pieces apart to nest them tightly
  - every piece carries its own cut line, the **glue outline of each piece
    that sits on it**, and the engraving and water that land on it
  - **assembly numbers**: piece ids are the layer number plus a letter
    (`5B` = second piece on layer 5). Each piece is engraved with its own id
    (`#5B`), and inside each glue outline is the id of the piece that goes
    there (`6A`). Both sit under the piece above, so they're hidden once glued.
    Labels turn sideways or shrink (to ~1.6 mm) to fit thin pieces
  - pieces with nothing on top can't hide their id, so it's in its own colour
    (magenta) for you to engrave lightly or switch off. Any piece too small for
    even a tiny number (a few mm across) is listed in the SVG metadata as
    `unnumberedPieces`; match those by shape against their glue outline
  - colours: **red** = cut, **blue** = glue outline, **black** = engrave
    (names, markers, special places, route, clock numbers), **green** = water
    score lines, **orange** = hidden assembly numbers, **magenta** = visible ids.
    Give each its own LightBurn layer; orange and green suit a quick light pass
  - all pieces sit in register (as assembled), so the file also shows the
    whole model
- **Cut sheets** (owner mode, layered maps): the same pieces laid flat on your
  sheets (600 × 400 mm by default), packed biggest-first and rotated to fit,
  with small pieces tucked into gaps and holes. Downloads as a ZIP of one SVG
  per sheet (origin at the sheet corner, ready to cut) plus `contents.txt`
  listing the pieces on each sheet. Pieces are at least 2 mm apart with a
  5 mm border. A piece bigger than a sheet gets its own file marked
  `OVERSIZE`. Tip: with pieces nested inside others' holes, turn on
  LightBurn's "cut inner shapes first"
  - islands and holes smaller than about 2 × 2 mm are removed, as they are too
    fragile to cut
  - the order details (bounds, interval, layer count, elevation range) are
    stored in the SVG's `<metadata>`
- **Engraving follows the layers.** Every label, marker and route is split so
  each part is engraved on whichever layer is on top at that spot. A name
  that runs from a summit down a slope is spread over several layers and
  reads as one once glued. Text is already converted to outlines (Noto Sans),
  so no fonts are needed in your laser software.

## Owner mode (downloading the SVG)

The **Download SVG** button only appears in your own browser:

1. Open the site once with your private key on the end:
   `https://<your-site>/?owner=<your key>`. The key disappears from the address
   bar and an "Owner mode" badge appears in the header.
2. From then on, in that browser, open any layout link a customer sends you
   and click **Create my layout**, then **Download SVG (owner)**. The layout
   uses the exact area from the link, not the slightly different area the
   map frame happens to show.
3. Click **turn off** in the badge to leave owner mode.

Only a SHA-256 hash of the key is stored in `js/config.js` (`ownerKeyHash`).
To change the key, put the new hash there:
`printf %s 'your-new-key' | sha256sum`.

This keeps the button away from customers. It is not strong security: the
layout is built in the browser, so a technical person could still extract it.

## Clock template

"Clock 305 mm" turns the layout into a round clock face, from
`scripts/source/clock-305.dxf`:

- **Outer circle**: every layer is trimmed to the circle (cut, red).
- **Numbers and hour marks**: engraved (black fill). On layered maps each part
  is engraved on whichever layer is on top at that spot, so a number crossing
  several contour levels is split across those layers.
- **10 mm centre circle**: treated as the **hole for the clock movement** and
  cut through every layer that covers the centre.

To change the clock or add another template, export a DXF with the outline on
`Layer_0` and the engraving on `Layer_2` (plus an optional centre circle), then:

```
pip install ezdxf
python3 scripts/build-clock.py path/to/new.dxf data/new-template.json
```

and add a size to `sizes` in `js/config.js`, e.g.
`{ id: "clock250", label: "Clock 250 mm", w: 250, h: 250, template: "data/new-template.json" }`.
Templates are round and scale to the size given.

## Setting it up

Edit [`js/config.js`](js/config.js):

| Setting | What it does |
| --- | --- |
| `businessName`, `tagline` | Shown in the header and page title |
| `orderEmail` | Where requests go by email (opens the customer's email app) |
| `formEndpoint` | Optional [Formspree](https://formspree.io) (or similar) URL. When set, requests are posted straight to you instead of using email |
| `sizes` | Board sizes offered |
| `thicknesses` | Material thicknesses, used to estimate stack height |
| `defaultThickness` | Thickness pre-selected on the order form |
| `ownerKeyHash` | Hash of your private owner key (see above) |
| `sheet` | Cutting sheet size, border and gap between pieces for the cut-sheets download |
| `maxLayers` | Above this, customers see a hint to use a larger contour interval |

## Publishing on GitHub Pages

The site is plain HTML, CSS and JavaScript with no build step.

1. Push to GitHub.
2. In the repository go to **Settings → Pages**. Set **Source** to *Deploy from
   a branch*, then pick the branch and the `/ (root)` folder.
3. The site appears at `https://<user>.github.io/<repo>/`.

To try it locally, run `python3 -m http.server` in this folder and open
<http://localhost:8000>. Opening `index.html` directly from disk won't work
because browsers block module scripts on `file://`.

## Project layout

```
index.html            page structure
css/style.css         styling (desktop and phone)
js/config.js          business settings, regions, hill lists
js/app.js             map, frame, form and share link
js/layout.js          elevation download, contour tracing, SVG output
js/viewer3d.js        3D preview of the stacked layers (three.js)
js/shapes.js          special place marker shapes
js/pieces.js          splits layers into numbered pieces with glue outlines
js/nest.js            packs pieces onto cutting sheets
js/zip.js             bundles the sheet files into one download
js/text.js            label text to outlines (opentype.js)
js/route.js           route files, share-link encoding, route band
js/water.js           loads rivers, lakes and coastline from data/water/
data/water/           UK water tiles, 0.1° each (built by scripts/build-water.py)
data/clock-305.json   clock face template (built by scripts/build-clock.py)
data/hills.geojson    636 named hills (built by scripts/build-hills.mjs)
fonts/                map label glyphs (Noto Sans, OFL)
vendor/               MapLibre GL JS 4.7.1, maplibre-contour 0.1.0, d3-contour 4.0.2, three.js r169, polygon-clipping 0.15.7, opentype.js 1.3.4
```

### Updating the water data

`data/water/` holds about 4,900 small tiles (39 MB in all) covering the UK and
Ireland. They come from [Overture Maps](https://overturemaps.org), a cleaned-up
copy of OpenStreetMap. To refresh them (OpenStreetMap is edited all the time):

```
pip install pyarrow shapely requests
python3 scripts/build-water.py download   # ~470 MB, UK parts only
python3 scripts/build-water.py build      # about 4 minutes
```

To use a newer Overture release, change `RELEASE` at the top of the script.
Tiny ponds (under 1,500 m²), ditches, drains and swimming pools are left out.

### Updating the hill data

`scripts/source/dobih-extract.json` is an extract of the Database of British
and Irish Hills v18.6. To rebuild the map data after editing it:

```
node scripts/build-hills.mjs
```

To add more lists (Hewitts, Marilyns, Nuttalls, …), download the full DoBIH
CSV from <https://www.hill-bagging.co.uk/dobih/downloads/>, add the hills and
list ids to the extract, rebuild, and add the list to `HILL_LISTS` in
`js/config.js`.

## Data and credits

- **Hills**: [The Database of British and Irish Hills](https://www.hill-bagging.co.uk/dobih)
  v18.6, [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Extract
  from [Bailsby/hill-bagger](https://github.com/Bailsby/hill-bagger).
- **Elevation**: [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/)
  (Mapzen Terrarium), which combine several sources including Environment
  Agency LIDAR (© Crown copyright). See the
  [attribution list](https://github.com/tilezen/joerd/blob/master/docs/attribution.md).
- **Water**: © [OpenStreetMap](https://www.openstreetmap.org/copyright)
  contributors (ODbL), via [Overture Maps](https://overturemaps.org). Built into
  `data/water/` by `scripts/build-water.py`, so no outside service is needed.
- **Libraries**: MapLibre GL JS (BSD-3), maplibre-contour (BSD-3), d3-contour
  and d3-array (ISC), three.js (MIT), polygon-clipping (MIT), opentype.js (MIT). Licences are in
  `vendor/`. Engraving font: Noto Sans (SIL OFL 1.1), in `fonts/engrave/`.

Elevation data is accurate enough for decorative work. It is not survey-grade,
and summit heights in the layout come from the hill database rather than the
terrain model.
