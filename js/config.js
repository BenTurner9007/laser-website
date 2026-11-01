// Business settings. Edit these before publishing the site.
export const CONFIG = {
  businessName: "TurnerMadeUK",
  tagline: "Laser-cut contour maps of the hills you love",

  // Where layout requests are emailed when no form endpoint is set.
  orderEmail: "bturner9007@gmail.com",

  // Send requests straight from the page (no email app). Get a free access
  // key at https://web3forms.com by entering orderEmail; requests then arrive
  // there with the customer's address as reply-to. 250 a month free.
  web3formsKey: "",

  // Alternative: a Formspree endpoint, e.g. "https://formspree.io/f/abcdwxyz".
  // If neither is set, "Send request" opens the customer's email app instead.
  formEndpoint: "",

  // Etsy mode: the site becomes a design tool and the order is placed on
  // Etsy. "Send request" becomes "Save my design", which gives the customer
  // a code to paste into the Etsy personalisation box (and, with a form
  // service above, emails you the design under that code). Turn it on for
  // everyone here, or just for Etsy visitors by linking to the site with
  // ?etsy=1 in your listing.
  etsy: {
    enabled: false,
    listingUrl: "", // your Etsy listing or shop, for the "Back to Etsy to buy" button
  },

  // Board sizes offered to customers, in millimetres.
  sizes: [
    { id: "a4p", label: "A4 portrait", w: 210, h: 297 },
    { id: "a4l", label: "A4 landscape", w: 297, h: 210 },
    { id: "a3p", label: "A3 portrait", w: 297, h: 420 },
    { id: "a3l", label: "A3 landscape", w: 420, h: 297 },
    // Board templates: shape, holes, map area and engraving come from the
    // JSON file (built from a DXF by scripts/build-templates.py); w and h
    // must match the template.
    { id: "clock305", label: "Clock 305 mm", w: 305, h: 305, template: "data/templates/clock-305.json" },
    { id: "bookmark", label: "Bookmark", w: 50.3, h: 168.91, template: "data/templates/bookmark.json" },
    { id: "coaster-round", label: "Round coaster", w: 100, h: 100, template: "data/templates/coaster-round.json" },
    { id: "coaster-square", label: "Square coaster", w: 98.65, h: 98.65, template: "data/templates/coaster-square.json" },
    { id: "coaster-rounded", label: "Rounded square coaster", w: 100, h: 100, template: "data/templates/coaster-rounded-square.json" },
  ],

  // Material thicknesses offered for layered designs, in millimetres.
  thicknesses: [1, 2, 3, 4, 6],
  // Thickness pre-selected on the order form.
  defaultThickness: 3,

  // SHA-256 of your private owner key. Open the site once with ?owner=<key>
  // and that browser will show "Download SVG" on every layout. Customers
  // never see the button. Change the key with: printf %s 'new-key' | sha256sum
  ownerKeyHash: "7cadbf249dcd2fafe249b54ce1fa0ca11fd43127bdf1e75716da65d5fb92819c",

  // Your cutting sheets, for the "laid out flat" download (millimetres).
  sheet: { w: 600, h: 400, marginMm: 5, gapMm: 2 },

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
