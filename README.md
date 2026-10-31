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
   contour interval, smoothing, and which hill lists to name.
4. **Preview and send**: an interactive **3D model** of the finished piece
   (each layer at the real material thickness, in birch, oak or acrylic, with
   a centimetre ruler, overall size, stack height and map scale), a flat plan,
   a share link, and a request form. Customers cannot download the SVG; they
   send you the layout and you download it.

**What you receive**

- A **share link** that reopens the exact area and settings, so you can
  regenerate the layout yourself at any time.
- A **production SVG** at real size (mm), downloaded by you in owner mode (below):
  - one Inkscape layer per contour level (`Layer 00 base`, `Layer 01 (200 m)` …)
  - **red** = cut, **blue** = score/glue guide (the outline of the layer
    above), **black** = engrave (peak markers and names)
  - all layers sit in register on top of each other, so separate or nest them
    onto sheets in Inkscape/LightBurn before cutting
  - islands and holes smaller than about 2 × 2 mm are removed, as they are too
    fragile to cut
  - the order details (bounds, interval, layer count, elevation range) are
    stored in the SVG's `<metadata>`
- Text is live SVG text (Arial). Convert it to paths in Inkscape
  (*Path → Object to Path*) if your laser software needs that.

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
data/clock-305.json   clock face template (built by scripts/build-clock.py)
data/hills.geojson    636 named hills (built by scripts/build-hills.mjs)
fonts/                map label glyphs (Noto Sans, OFL)
vendor/               MapLibre GL JS 4.7.1, maplibre-contour 0.1.0, d3-contour 4.0.2, three.js r169, polygon-clipping 0.15.7
```

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
- **Optional extra peaks and street map**: © [OpenStreetMap](https://www.openstreetmap.org/copyright)
  contributors, via the Overpass API and the OSM tile servers. Both are free
  community services, so keep their use light. If the site gets busy, switch
  the street map to a paid tile provider.
- **Libraries**: MapLibre GL JS (BSD-3), maplibre-contour (BSD-3), d3-contour
  and d3-array (ISC), three.js (MIT), polygon-clipping (MIT). Licences are in `vendor/`.

Elevation data is accurate enough for decorative work. It is not survey-grade,
and summit heights in the layout come from the hill database rather than the
terrain model.
