// Business settings. Edit these before publishing the site.
export const CONFIG = {
  businessName: "TurnerMadeUK",
  tagline: "Laser-cut contour maps of the hills you love",

  // Where layout requests are emailed when no form endpoint is set.
  orderEmail: "bturner9007@gmail.com",

  // Optional: a Formspree (or similar) endpoint that accepts JSON POSTs,
  // e.g. "https://formspree.io/f/abcdwxyz". Leave empty to use email instead.
  formEndpoint: "",

  // Board sizes offered to customers, in millimetres.
  sizes: [
    { id: "a4p", label: "A4 portrait", w: 210, h: 297 },
    { id: "a4l", label: "A4 landscape", w: 297, h: 210 },
    { id: "a3p", label: "A3 portrait", w: 297, h: 420 },
    { id: "a3l", label: "A3 landscape", w: 420, h: 297 },
    { id: "sq30", label: "Square 300 mm", w: 300, h: 300 },
    { id: "sq20", label: "Square 200 mm", w: 200, h: 200 },
    { id: "coaster", label: "Coaster 100 mm", w: 100, h: 100 },
  ],

  // Material thicknesses offered for layered designs, in millimetres.
  thicknesses: [1, 2, 3, 4, 6],
  // Thickness pre-selected on the order form.
  defaultThickness: 3,

  // SHA-256 of your private owner key. Open the site once with ?owner=<key>
  // and that browser will show "Download SVG" on every layout. Customers
  // never see the button. Change the key with: printf %s 'new-key' | sha256sum
  ownerKeyHash: "7cadbf249dcd2fafe249b54ce1fa0ca11fd43127bdf1e75716da65d5fb92819c",

  // Largest layer count you are willing to quote automatically.
  maxLayers: 30,
};

// Quick-jump regions: [lng, lat, zoom].
export const REGIONS = [
  { label: "Lake District", at: [-3.1, 54.48, 10.6] },
  { label: "Eryri / Snowdonia", at: [-3.98, 53.08, 11] },
  { label: "Peak District", at: [-1.85, 53.38, 10.6] },
  { label: "Yorkshire Dales", at: [-2.2, 54.22, 10.4] },
  { label: "Ben Nevis & Glen Coe", at: [-5.0, 56.74, 10.6] },
  { label: "Cairngorms", at: [-3.67, 57.08, 10.6] },
];

// Hill lists in data/hills.geojson, in display order.
export const HILL_LISTS = [
  { id: "wainwrights", label: "Wainwrights", on: true },
  { id: "munros", label: "Munros", on: true },
  { id: "welsh-3000s", label: "Welsh 3000s", on: true },
  { id: "ethels", label: "Ethels (Peak District)", on: true },
  { id: "dales-30", label: "Dales 30", on: true },
  { id: "yorkshire-three-peaks", label: "Yorkshire Three Peaks", on: true },
];
