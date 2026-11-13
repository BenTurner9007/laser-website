"""Build the product pages (clocks/, coasters/, bookmarks/) from index.html.

    python3 scripts/build-pages.py

Each page is a copy of index.html with its own address, title and
description, and data-page set so the site only offers that page's board
sizes (see `pages` in js/config.js). A <base href="../"> makes the copy load
the same css/, js/, data/ and fonts/ as the main page, so there is one site to
maintain. Run this again after changing index.html.
"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "index.html"

SITE = "https://turnermadeuk.co.uk/"
# Each product page: brand title, heading for search engines, <title>,
# description, structured-data product, and the "about" text in the footer.
PAGES = {
    "clocks": dict(
        brand="Contour Clock Designer",
        h1="TurnerMadeUK: design a personalised contour map wall clock",
        title="Personalised Contour Map Wall Clock of UK &amp; Irish Hills | TurnerMadeUK",
        description="Design a laser-engraved wooden wall clock showing the contours of any hills in Great Britain or Ireland. 305 mm across, made to order.",
        og="A wall clock engraved with the hills you love",
        product="Personalised contour map wall clock",
        product_desc="A 305 mm wooden wall clock, laser-engraved with the contours, rivers and hill names of any area of Great Britain or Ireland, with clock numbers round the edge.",
        summary="About our contour clocks",
        about="""      <h2>A wall clock engraved with the hills you love</h2>
      <p>TurnerMadeUK makes wooden wall clocks engraved with a contour map of any hills in Great Britain or Ireland. The clock is 305 mm across, laser-engraved on a single board, with the numbers 12, 3, 6 and 9 and hour marks round the edge.</p>
      <p>You choose the area on the map above. You can add hill names and heights, rivers, lakes, roads and footpaths, mark a special place with a heart, star or pin, add your own words, and add a walking route drawn on the map or uploaded from Strava, Komoot or OS Maps. An optional 5 mm frame can be added round the edge.</p>
      <p>You see the clock in 3D before you order, and each one is made to order in the UK.""",
    ),
    "coasters": dict(
        brand="Contour Coaster Designer",
        h1="TurnerMadeUK: design personalised contour map coasters",
        title="Personalised Contour Map Coasters of UK &amp; Irish Hills | TurnerMadeUK",
        description="Design laser-engraved wooden coasters showing the contours of your favourite hills in Great Britain or Ireland. Round or square, singly or in sets of up to four.",
        og="Engraved coasters of your favourite hills",
        product="Personalised contour map coaster",
        product_desc="A 100 mm wooden coaster in 2 mm ceiba plywood, laser-engraved with the contours and hill names of any area of Great Britain or Ireland. Round, square or rounded square, singly or in sets of up to four.",
        summary="About our contour coasters",
        about="""      <h2>Engraved coasters of your favourite hills</h2>
      <p>TurnerMadeUK makes wooden coasters laser-engraved with a contour map of any hills in Great Britain or Ireland. Each coaster is about 100 mm across, in 2 mm ceiba plywood, and comes round, square or rounded square.</p>
      <p>You choose the area on the map above, and can add hill names, rivers, lakes and paths, a special place and your own words. Coasters can be ordered singly or as a set of up to four of the same design, and each extra coaster in a set costs a little less.</p>
      <p>They make a small gift for walkers: a favourite fell, a first Munro, or the hill behind the house.""",
    ),
    "bookmarks": dict(
        brand="Contour Bookmark Designer",
        h1="TurnerMadeUK: design a personalised contour map bookmark",
        title="Personalised Contour Map Bookmark of UK &amp; Irish Hills | TurnerMadeUK",
        description="Design a laser-engraved wooden bookmark showing the contours of any hills in Great Britain or Ireland. A small, personal gift for walkers who read.",
        og="An engraved bookmark of the hills you love",
        product="Personalised contour map bookmark",
        product_desc="A wooden bookmark (about 50 × 169 mm) in 2 mm ceiba plywood, laser-engraved with the contours and hill names of any area of Great Britain or Ireland.",
        summary="About our contour bookmarks",
        about="""      <h2>An engraved bookmark of the hills you love</h2>
      <p>TurnerMadeUK makes wooden bookmarks laser-engraved with a contour map of any hills in Great Britain or Ireland. Each bookmark is about 50 × 169 mm, in 2 mm ceiba plywood.</p>
      <p>You choose the area on the map above, and can add hill names, rivers and lakes, a special place and your own words, such as a name or a date.</p>
      <p>It is a small, personal gift for a walker who reads: a favourite summit, a long-distance path, or the hills from a holiday.""",
    ),
}


def between(html, name, body):
    """Replace what is between <!-- name:start ... --> and <!-- name:end -->."""
    a = html.index(f"<!-- {name}:start")
    a = html.index("-->", a) + 3
    b = html.index(f"<!-- {name}:end -->")
    return html[:a] + "\n" + body + "\n  " + html[b:]


def build():
    html = SRC.read_text()
    assert '<body data-page="maps">' in html, "index.html should have <body data-page=\"maps\">"
    for page, p in PAGES.items():
        url = f"{SITE}{page}/"
        ld = {
            "@context": "https://schema.org",
            "@type": "Product",
            "name": p["product"],
            "description": p["product_desc"],
            "image": f"{SITE}images/social-preview.jpg",
            "material": "Plywood",
            "brand": {"@type": "Organization", "name": "TurnerMadeUK", "url": SITE},
            "url": url,
        }
        head = f"""  <title>{p["title"]}</title>
  <meta name="description" content="{p["description"]}">
  <link rel="canonical" href="{url}">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="TurnerMadeUK">
  <meta property="og:title" content="{p["og"]}">
  <meta property="og:description" content="{p["description"]}">
  <meta property="og:url" content="{url}">
  <meta property="og:image" content="{SITE}images/social-preview.jpg">
  <meta name="twitter:card" content="summary_large_image">
  <script type="application/ld+json">{json.dumps(ld, ensure_ascii=False, separators=(",", ":"))}</script>"""
        about = f"""    <details class="about">
      <summary>{p["summary"]}</summary>
{p["about"]} <a href="faq.html">Questions and answers</a> · <a href="guide.html">How to design your map</a></p>
    </details>
  """
        out = html.replace("<head>", '<head>\n  <base href="../">', 1)
        out = out.replace('<body data-page="maps">', f'<body data-page="{page}">', 1)
        out = between(out, "seo", head)
        out = between(out, "about", about.rstrip())
        out = re.sub(r'(<h1 id="brand-name"[^>]*>)[^<]*(</h1>)', rf"\g<1>{p['h1']}\g<2>", out, count=1)
        out = out.replace('<p class="brand-title">Contour Map Designer</p>', f'<p class="brand-title">{p["brand"]}</p>', 1)
        out = out.replace(
            "<!doctype html>",
            "<!doctype html>\n<!-- Built from index.html by scripts/build-pages.py: edit index.html, then run the script. -->",
            1,
        )
        (ROOT / page).mkdir(exist_ok=True)
        (ROOT / page / "index.html").write_text(out)
        print(f"{page}/index.html")


if __name__ == "__main__":
    build()
