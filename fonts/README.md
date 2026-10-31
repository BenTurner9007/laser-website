# Map label fonts

Signed-distance-field glyph files used by MapLibre to draw map labels, so the
site does not depend on a third-party font server.

- Font: Noto Sans (Regular, Bold), SIL Open Font License 1.1
- Glyph PBFs from https://github.com/klokantech/klokantech-gl-fonts
- Ranges included: 0-255 (Latin), 256-511 (Latin Extended, e.g. Welsh ŵ ŷ),
  8192-8447 (punctuation such as – and ’).

## Engraving font (`engrave/`)

Labels in the laser layouts are converted to outlines with
[opentype.js](https://opentype.js.org/), so the SVG needs no fonts.

- Font: Noto Sans Regular and Bold (WOFF), SIL Open Font License 1.1, from
  the [@fontsource/noto-sans](https://fontsource.org/fonts/noto-sans) package
- `latin` covers English; `latin-ext` adds Welsh and other accented letters
