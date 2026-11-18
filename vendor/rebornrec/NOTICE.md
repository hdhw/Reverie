# RebornRec catalog data

These files are copied unmodified from https://github.com/hdhw/RebornRec
(its README credits aqquad/RebornRec as the origin), commit `c912137bd60eeafc2049f857ba8a05a2bb06140b` (2026-03-10).

| File | Used as |
| --- | --- |
| `avataritems.txt` | `server/Data/APIS/Items/AvatarItems.json` and `AvatarItemsDefault.json` |
| `equipment.txt` | `server/Data/APIS/Items/Equipment.json` |
| `consumables.txt` | `server/Data/APIS/Items/Consumables.json` and `ConsumablesDefault.json` |
| `gameconfigs.txt` | `server/Data/APIS/GameConfigs.json` |

The RebornRec repository has no license file. Its README describes these as data files
the (closed-source) RebornRec server downloads at runtime. The item data describes
Rec Room content owned by Rec Room Inc.; Reverie is not affiliated with Rec Room or RebornRec.

RebornRec targets 2016–2020 clients. These catalogs have not been verified against the
2023 client Mocha targets; items whose prefabs don't exist in a given build may not render.

The importer (`app/lib/catalog.mjs`) never overwrites catalog files you've edited unless
run with `--force`.
