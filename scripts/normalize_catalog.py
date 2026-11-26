#!/usr/bin/env python3
"""Limpia el catálogo extraído: quita campos no usados, elimina duplicados y ordena por marca/modelo/año.

Uso: python3 scripts/normalize_catalog.py public/data/vehiculos-autodata.json public/data/vehiculos.json
"""
import json
import sys

KEEP = ["marca", "modelo", "generacion", "desde", "hasta", "carroceria", "L", "W", "H", "batalla", "viaD", "viaT", "volD", "volT", "masa", "mma", "traccion", "neumaticos", "fuente"]

src, dst = sys.argv[1], sys.argv[2]
data = json.load(open(src, encoding="utf-8"))
seen = set()
out = []
for r in data:
    if "carroceria" not in r and "tipo" in r:
        r["carroceria"] = r["tipo"]
    if not r.get("L") and not r.get("masa"):
        continue  # sin medidas ni peso no aporta nada
    key = (r.get("marca"), r.get("generacion"))
    if key in seen:
        continue
    seen.add(key)
    rec = {k: r[k] for k in KEEP if k in r and r[k] not in (None, "")}
    for k in ("L", "W", "H", "batalla", "viaD", "viaT", "volD", "volT", "masa", "mma"):
        if k in rec:
            rec[k] = int(round(rec[k]))
    if "neumaticos" in rec:
        rec["neumaticos"] = rec["neumaticos"].split(";")[0].strip()
    out.append(rec)
out.sort(key=lambda r: (r["marca"].lower(), r["modelo"].lower(), r.get("desde") or 0))
json.dump(out, open(dst, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
print(f"{len(out)} generaciones → {dst}")
