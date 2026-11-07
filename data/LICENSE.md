# Data licences

The map data in this folder is shared under the licences below. You may use it,
including commercially, as long as you follow the licence for each part.

## OpenStreetMap data: Open Database Licence (ODbL) 1.0

- `water/`: rivers, lakes, streams, coastline, lake areas and the sea
- `roads/`: roads, tracks and paths
- `places.json`: city, town and village names
- `hills.geojson`: the hills with the list "osm" (other named peaks, added by
  `build-peaks.py`)

These are derived databases of OpenStreetMap data, made from the
[Overture Maps](https://overturemaps.org) release 2026-10-21.0 by the scripts
in `scripts/` (`build-water.py`, `build-roads.py`, `build-places.py`), which
show exactly how they were made.

© OpenStreetMap contributors. Made available under the
[Open Database Licence](https://opendatacommons.org/licenses/odbl/1-0/). Any
rights in individual contents of the database are licensed under the
[Database Contents Licence](https://opendatacommons.org/licenses/dbcl/1-0/).
See <https://www.openstreetmap.org/copyright>.

If you share an adapted version of these databases, you must share it under
the ODbL too.

## Hill data: Creative Commons Attribution 4.0

- `hills.geojson`: the hills on the named lists (Wainwrights, Munros and so on)

From [The Database of British and Irish Hills](https://www.hill-bagging.co.uk/dobih)
v18.6, licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
Changes: reduced to the lists and fields this site uses.

## Moon and Mars: public domain / CC0

- `planets/`: elevation tiles, sites and feature names

Moon: SLDEM2015 (NASA LRO LOLA and JAXA SELENE/Kaguya), via the USGS
Astrogeology Science Center. Mars: MRO CTX digital terrain models
(NASA/JPL/MSSS), processed by USGS Astrogeology (CC0). Feature names: IAU
Gazetteer of Planetary Nomenclature.

## Not covered here

- `templates/`, `materials.json`, `logo.json`: the shop's own designs, price
  list and logo. Not openly licensed.
- Earth elevation is not stored here: it is loaded from
  [Mapzen Terrain Tiles on AWS](https://registry.opendata.aws/terrain-tiles/)
  ([sources and attribution](https://github.com/tilezen/joerd/blob/master/docs/attribution.md)).
  Contains Environment Agency information © Environment Agency and/or
  database right.
