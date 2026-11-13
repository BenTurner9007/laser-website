"""Build faq.html (questions and answers) from the list below.

    python3 scripts/build-faq.py

The same questions go into the page and into its FAQPage structured data, so
search engines and AI assistants can quote them. Each answer starts with a
sentence that makes sense on its own. Edit QA, then run this again.
"""
import html
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITE = "https://turnermadeuk.co.uk/"

# (section, question, answer as HTML). Keep the first sentence a full answer.
QA = [
    ("About the maps", "What does TurnerMadeUK make?",
     "TurnerMadeUK makes laser-cut and laser-engraved wooden maps of any hills, coast or town in Great Britain and Ireland. "
     "You design the piece yourself on our website, and we make it to order in the UK. As well as contour maps we make "
     "<a href=\"clocks/\">wall clocks</a>, <a href=\"coasters/\">coasters</a> and <a href=\"bookmarks/\">bookmarks</a> engraved with the same maps."),
    ("About the maps", "What is a layered contour map?",
     "A layered contour map is a 3D model of the land built from stacked sheets of wood, one layer for each contour line. "
     "Each layer is laser-cut to the shape of the hills at that height, so when the layers are glued together the hills stand up like the real landscape. "
     "You choose the height between contours, which sets how many layers there are."),
    ("About the maps", "What is the difference between a layered map and an engraved map?",
     "A layered map is cut into stacked wooden layers so the hills are raised in 3D, while an engraved map is one flat board with the contour lines burnt onto it. "
     "Layered maps are thicker and show the shape of the land; engraved boards are slimmer and show fine detail. Clocks, coasters and bookmarks are always single engraved boards."),
    ("About the maps", "Which places can I have a map of?",
     "You can have a map of anywhere in Great Britain or Ireland, including Northern Ireland and the islands. "
     "That covers every fell, Munro, valley, coastline and town, such as the Lake District, Eryri (Snowdonia), the Peak District, the Yorkshire Dales, "
     "the Scottish Highlands, the Brecon Beacons, Dartmoor, the Mourne Mountains and the hills of Ireland."),
    ("About the maps", "What sizes do the maps come in?",
     "Maps come in A4 (210 × 297 mm) and A3 (297 × 420 mm), portrait or landscape, as an A4 round (210 mm across), or in a shape you draw yourself round the area you want. "
     "Clocks are 305 mm across, coasters about 100 mm and bookmarks about 50 × 169 mm."),
    ("About the maps", "What wood are the maps made from?",
     "The maps are laser-cut from plywood. You can choose from poplar, birch-faced poplar, maple-faced poplar, birch and ceiba plywood, in several thicknesses. "
     "Coasters and bookmarks are made in 2 mm ceiba plywood. Wood is a natural material, so grain and colour vary from piece to piece."),
    ("About the maps", "Are the maps Ordnance Survey maps?",
     "No, the maps are not Ordnance Survey maps. They are made from open data: heights from open terrain data, hill names from the Database of British and Irish Hills, "
     "and rivers, lakes, roads, paths and place names from OpenStreetMap. The full credits are on our <a href=\"licences.html\">data licences</a> page. "
     "The maps are decorative and are not for navigation."),

    ("Personalising", "Can I add my own walking or running route to the map?",
     "Yes, you can add your own route to any map. Draw it on the map, or upload a GPX, KML or GeoJSON file from your GPS or an app such as Strava, Komoot, OS Maps or AllTrails. "
     "The route is engraved as a line that follows the hills across the layers."),
    ("Personalising", "Can I mark a special place, such as where we got engaged?",
     "Yes, you can mark up to three special places on a map. Each one has a marker (heart, star, pin, house, circle, cross, diamond or triangle) and your own words beside it, "
     "for example where you got engaged, a favourite summit or a holiday cottage."),
    ("Personalising", "Can I add names, a date or a message?",
     "Yes, you can add up to three blocks of your own text, such as names, a date or a short message. "
     "You place and size each one yourself on the map, and it is engraved in the same lettering as the hill names."),
    ("Personalising", "Which hill names are shown on the maps?",
     "The maps can show hill names and heights from the Wainwrights, Munros, Welsh 3000s, Ethels, Dales 30 and Yorkshire Three Peaks, plus more than 15,000 other named hills. "
     "You can also show town and village names, rivers, lakes, coastline, roads, tracks and footpaths."),
    ("Personalising", "Can I see my map before I order?",
     "Yes, you see your design as a 3D model and as a flat plan before you order. "
     "You can turn the 3D model, zoom in, and look at the back, and change anything until you are happy with it."),

    ("Gifts", "What is a good gift for someone who has climbed all the Wainwrights or Munros?",
     "A personalised wooden contour map of the hills they climbed makes a lasting gift for someone who has completed the Wainwrights or the Munros. "
     "You can frame their final summit, add its name and height, mark the day with a date, and include the route they walked."),
    ("Gifts", "Can I make a map of where we got married or engaged?",
     "Yes, you can make a map of the place you got engaged or married. "
     "Mark the exact spot with a heart, add your names and the date, and include the walk you did that day if you like."),
    ("Gifts", "Do you make smaller gifts?",
     "Yes, we make <a href=\"coasters/\">coasters</a> and <a href=\"bookmarks/\">bookmarks</a> engraved with a contour map of any hills, as smaller gifts. "
     "Coasters can be ordered singly or in sets of up to four."),

    ("Ordering", "How do I order a map?",
     "To order, design your map on our website and press Send request. "
     "You search for a hill, town or postcode, pick a board size, choose what to show, and create your layout. We then reply by email to confirm the details and the price before anything is made. "
     "Our <a href=\"guide.html\">step-by-step guide</a> explains every option."),
    ("Ordering", "Can I order through Etsy?",
     "Yes, you can order through our Etsy shop. Design your piece on our website and press Save my design to get a short design code, "
     "then paste the code into the personalisation box when you buy the matching listing on Etsy."),
    ("Ordering", "How much does a map cost?",
     "The price depends on the size, the number of layers and the wood you choose. "
     "We confirm the price by email when we reply to your design request, before anything is made."),
    ("Ordering", "Does the designer work on a phone?",
     "Yes, the designer works on phones, tablets and computers. On a phone the map stays at the top of the screen while you move through the steps below it."),
]


def plain(a):
    return html.unescape(re.sub(r"<[^>]+>", "", a))


def build():
    sections = []
    for sec in dict.fromkeys(s for s, _, _ in QA):
        items = "\n".join(f"      <h3>{html.escape(q)}</h3>\n      <p>{a}</p>" for s, q, a in QA if s == sec)
        sections.append(f"    <section>\n      <h2>{sec}</h2>\n{items}\n    </section>")
    ld = {
        "@context": "https://schema.org",
        "@type": "FAQPage",
        "mainEntity": [{"@type": "Question", "name": q, "acceptedAnswer": {"@type": "Answer", "text": plain(a)}} for _, q, a in QA],
    }
    page = f"""<!doctype html>
<!-- Built by scripts/build-faq.py: edit the questions there, then run the script. -->
<html lang="en-GB">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Questions and Answers: Personalised Wooden Contour Maps | TurnerMadeUK</title>
  <meta name="description" content="Answers about TurnerMadeUK's laser-cut wooden contour maps: what they are, sizes, woods, adding your route or a special place, gifts, and how to order.">
  <link rel="canonical" href="{SITE}faq">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="TurnerMadeUK">
  <meta property="og:title" content="Questions and answers about our wooden contour maps">
  <meta property="og:url" content="{SITE}faq">
  <meta property="og:image" content="{SITE}images/social-preview.jpg">
  <meta name="twitter:card" content="summary_large_image">
  <link rel="icon" type="image/png" href="images/icon.png">
  <link rel="stylesheet" href="css/fonts.css">
  <link rel="stylesheet" href="css/style.css">
  <style>
    body {{ display: block; height: auto; }}
    .faq {{ max-width: 760px; margin: 0 auto; padding: 24px 20px 56px; line-height: 1.6; }}
    .faq h1 {{ font-family: var(--display); font-weight: 600; font-size: 2rem; margin: 0 0 6px; line-height: 1.15; }}
    .faq h2 {{ font-family: var(--display); font-weight: 600; font-size: 1.4rem; margin: 36px 0 4px; padding-top: 8px; border-top: 1px solid var(--line); }}
    .faq h3 {{ font-size: 1.05rem; margin: 20px 0 4px; }}
    .faq p {{ margin: 0 0 8px; }}
    .faq .lead {{ color: var(--muted); font-size: 1.05rem; }}
    .faq .cta {{ display: inline-block; margin-top: 16px; padding: 12px 20px; border-radius: 12px; background: var(--accent); color: var(--accent-ink); text-decoration: none; font-weight: 600; }}
  </style>
  <script type="application/ld+json">{json.dumps(ld, ensure_ascii=False, separators=(",", ":"))}</script>
</head>
<body>
  <main class="faq">
    <p><a href="./">← Back to the map designer</a></p>
    <h1>Questions and answers</h1>
    <p class="lead">TurnerMadeUK makes personalised wooden contour maps of any hills in Great Britain and Ireland, laser-cut to order. Here are the questions we are asked most.</p>
{chr(10).join(sections)}
    <p><a class="cta" href="./">Design your map</a></p>
    <p><a href="guide.html">How to design your map</a> · <a href="terms.html">Terms</a> · <a href="privacy.html">Privacy</a> · <a href="licences.html">Data licences</a></p>
  </main>
</body>
</html>
"""
    (ROOT / "faq.html").write_text(page)
    print(f"faq.html: {len(QA)} questions")


if __name__ == "__main__":
    build()
