# Contour Map Designer

A website where customers choose an area of the British hills, frame it to a
board size, and send it as a layout for a laser-cut contour map.

**What customers do**

1. **Find their hills**: search any Wainwright, Munro, Welsh 3000, Ethel or
   Dales 30 hill, or jump to a region.
2. **Pick a board size**: A4, A3, square, coaster or custom millimetres. A
   fixed frame shows exactly what will be cut; they pan and zoom the map
   underneath it.
3. **Style it**: layered (stacked boards) or a single engraved board, the
   contour interval, smoothing, and which hill lists to name.
4. **Preview and send**: a wood-tone preview, a downloadable SVG, a share link,
   and a request form.

**What you receive**

- A **share link** that reopens the exact area and settings, so you can
  regenerate the layout yourself at any time.
- A **production SVG** at real size (mm):
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

## Setting it up

Edit [`js/config.js`](js/config.js):

| Setting | What it does |
| --- | --- |
| `businessName`, `tagline` | Shown in the header and page title |
| `orderEmail` | Where requests go by email (opens the customer's email app) |
| `formEndpoint` | Optional [Formspree](https://formspree.io) (or similar) URL. When set, requests are posted straight to you instead of using email |
| `sizes` | Board sizes offered |
| `thicknesses` | Material thicknesses, used to estimate stack height |
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
data/hills.geojson    636 named hills (built by scripts/build-hills.mjs)
fonts/                map label glyphs (Noto Sans, OFL)
vendor/               MapLibre GL JS 4.7.1, maplibre-contour 0.1.0, d3-contour 4.0.2
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
  and d3-array (ISC). Licences are in `vendor/`.

Elevation data is accurate enough for decorative work. It is not survey-grade,
and summit heights in the layout come from the hill database rather than the
terrain model.
