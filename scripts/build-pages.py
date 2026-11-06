"""Build the product pages (clocks/, coasters/, bookmarks/) from index.html.

    python3 scripts/build-pages.py

Each page is a copy of index.html with its own address, title and
description, and data-page set so the site only offers that page's board
sizes (see `pages` in js/config.js). A <base href="../"> makes the copy load
the same css/, js/, data/ and fonts/ as the main page, so there is one site to
maintain. Run this again after changing index.html.
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "index.html"

PAGES = {
    "clocks": ("Contour Clock Designer", "Design a laser-engraved wall clock of any hills in Great Britain or Ireland."),
    "coasters": ("Contour Coaster Designer", "Design laser-engraved contour map coasters of any hills in Great Britain or Ireland, singly or in sets."),
    "bookmarks": ("Contour Bookmark Designer", "Design a laser-engraved contour map bookmark of any hills in Great Britain or Ireland."),
}


def build():
    html = SRC.read_text()
    assert '<body data-page="maps">' in html, "index.html should have <body data-page=\"maps\">"
    for page, (title, description) in PAGES.items():
        out = html.replace("<head>", '<head>\n  <base href="../">', 1)
        out = out.replace('<body data-page="maps">', f'<body data-page="{page}">', 1)
        out = re.sub(r"<title>[^<]*</title>", f"<title>{title}</title>", out, count=1)
        out = re.sub(r'(<meta name="description" content=")[^"]*(")', rf"\g<1>{description}\g<2>", out, count=1)
        out = out.replace('<p class="brand-title">Contour Map Designer</p>', f'<p class="brand-title">{title}</p>', 1)
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
