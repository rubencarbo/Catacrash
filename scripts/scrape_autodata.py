#!/usr/bin/env python3
"""
Genera public/data/vehiculos.json con medidas y pesos de turismos y furgonetas a partir de
las fichas de auto-data.net (uso personal, no comercial).

- Recorre marcas → modelos → generaciones (desde MIN_YEAR) y toma una versión por generación.
- Cachea cada página en disco para poder reanudar sin repetir descargas.
- Peticiones moderadas (pocas a la vez y con pausa) para no cargar el sitio.

Uso:  python3 scripts/scrape_autodata.py <dir_cache> [salida.json]
"""
import html
import json
import os
import re
import sys
import time
import hashlib
import urllib.request
from concurrent.futures import ThreadPoolExecutor

BASE = "https://www.auto-data.net"
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36"
MIN_YEAR = 1985
WORKERS = 3
PAUSE = 0.35

CACHE = sys.argv[1] if len(sys.argv) > 1 else "/tmp/autodata-cache"
OUT = sys.argv[2] if len(sys.argv) > 2 else "public/data/vehiculos.json"
os.makedirs(CACHE, exist_ok=True)


def get(path: str) -> str:
    key = hashlib.sha1(path.encode()).hexdigest()
    fn = os.path.join(CACHE, key + ".html")
    if os.path.exists(fn):
        with open(fn, encoding="utf-8") as f:
            return f.read()
    for attempt in range(4):
        try:
            req = urllib.request.Request(BASE + path, headers={"User-Agent": UA, "Accept-Language": "es-ES,es;q=0.9"})
            with urllib.request.urlopen(req, timeout=30) as r:
                s = r.read().decode("utf-8", "replace")
            with open(fn, "w", encoding="utf-8") as f:
                f.write(s)
            time.sleep(PAUSE)
            return s
        except Exception as e:  # noqa: BLE001
            time.sleep(2 * (attempt + 1))
            err = e
    print("FALLO", path, err, file=sys.stderr)
    return ""


def text(s: str) -> str:
    return html.unescape(re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", s))).strip()


def num(v: str):
    """Primer número de un valor ('1534-1545 mm' → media 1539.5; '1253 kg' → 1253)."""
    if not v:
        return None
    m = re.search(r"(\d+(?:[.,]\d+)?)\s*-\s*(\d+(?:[.,]\d+)?)", v)
    if m:
        a, b = float(m.group(1).replace(",", ".")), float(m.group(2).replace(",", "."))
        return round((a + b) / 2, 1)
    m = re.search(r"\d+(?:[.,]\d+)?", v)
    return float(m.group(0).replace(",", ".")) if m else None


def brands():
    s = get("/es/")
    out = []
    for href, title in re.findall(r'href="(/es/[a-z0-9-]+-brand-\d+)" title="([^"]+?) - ', s):
        if (href, title) not in out:
            out.append((href, html.unescape(title)))
    return out


def models(brand_href: str):
    s = get(brand_href)
    seen = []
    for href in re.findall(r'href="(/es/[a-z0-9-]+-model-\d+)"', s):
        if href not in seen:
            seen.append(href)
    return seen


def generations(model_href: str):
    s = get(model_href)
    gens = []
    for block in re.findall(r'<a\s+id="\d+"\s+class="generation[^"]*"(.*?)</a>', s, re.S):
        href = re.search(r'href="([^"]+)"', block)
        tit = re.search(r'<strong class="tit">(.*?)</strong>', block)
        details = [text(d) for d in re.findall(r'<span class="generation-details">(.*?)</span>', block)]
        years = re.search(r'generation-years[^"]*">([^<]*)<', block)
        if not href or not tit:
            continue
        y = (years.group(1) if years else "").replace(" ", "")
        ys = re.findall(r"\d{4}", y)
        y0 = int(ys[0]) if ys else None
        y1 = int(ys[1]) if len(ys) > 1 else None
        if y0 is not None and (y1 or 9999) < MIN_YEAR:
            continue
        gens.append({"href": href.group(1), "title": text(tit.group(1)), "body": details[0] if details else "", "y0": y0, "y1": y1})
    return gens


def modifications(gen_href: str):
    s = get(gen_href)
    stem = gen_href.rsplit("-generation-", 1)[0]
    links = []
    for href in re.findall(r'href="(' + re.escape(stem) + r'-[^"]*-\d+)"', s):
        if "-generation-" in href or href in links:
            continue
        links.append(href)
    return links


FIELDS = {
    "Tipo de carrocería": "carroceria",
    "Número de puertas": "puertas",
    "Número de asientos": "plazas",
    "Peso en orden de marcha": "masa",
    "Peso en vacío": "masa",
    "Peso máximo admisible": "mma",
    "Peso máximo": "mma",
    "Longitud": "L",
    "Anchura": "W",
    "Anchura incluidos los espejos": "Wesp",
    "Altura": "H",
    "Distancia entre ejes": "batalla",
    "Vía delantera": "viaD",
    "Vía trasera": "viaT",
    "Voladizo delantero": "volD",
    "Voladizo trasero": "volT",
    "Diámetro mínimo de giro": "giro",
    "Tracción": "traccion",
    "Tamaño de neumáticos": "neumaticos",
    "Dimensiones de los neumáticos": "neumaticos",
    "Altura libre": "alturaLibre",
}
NUMERIC = {"masa", "mma", "L", "W", "Wesp", "H", "batalla", "viaD", "viaT", "volD", "volT", "giro", "alturaLibre", "puertas", "plazas"}


def modification(href: str):
    s = get(href)
    out = {}
    for par, val in re.findall(r'<div class="par">(.*?)</div>\s*<div class="val">(.*?)</div>', s, re.S):
        k = text(par)
        v = text(re.sub(r'<span class="val2">.*?</span>', "", val, flags=re.S))
        key = FIELDS.get(k)
        if key and key not in out:
            out[key] = num(v) if key in NUMERIC else v
    return out


def process_generation(brand: str, model_name: str, g: dict):
    rec = {"marca": brand, "modelo": model_name, "generacion": g["title"], "desde": g["y0"], "hasta": g["y1"], "tipo": g["body"]}
    rec["fuente"] = BASE + g["href"]
    # Primera versión con medidas y peso (se prueban hasta tres)
    for mod in modifications(g["href"])[:3]:
        d = modification(mod)
        for k, v in d.items():
            rec.setdefault(k, v)
        rec["fuente"] = BASE + mod
        if "masa" in rec and "L" in rec and "batalla" in rec:
            break
    return {k: v for k, v in rec.items() if v not in (None, "")}


def main():
    t0 = time.time()
    out = []
    bl = brands()
    only = os.environ.get("SOLO_MARCAS")
    if only:
        bl = [b for b in bl if b[1].lower() in [x.strip().lower() for x in only.split(",")]]
    print(f"{len(bl)} marcas", flush=True)
    for bi, (bhref, bname) in enumerate(bl):
        jobs = []
        bslug = bhref.rsplit("-brand-", 1)[0].split("/es/", 1)[1]
        for mhref in models(bhref):
            mslug = mhref.rsplit("-model-", 1)[0].split("/es/", 1)[1]
            mname = mslug[len(bslug) + 1 :] if mslug.startswith(bslug + "-") else mslug
            mname = mname.replace("-", " ").title()
            for g in generations(mhref):
                jobs.append((mname, g))
        with ThreadPoolExecutor(WORKERS) as ex:
            res = list(ex.map(lambda j: process_generation(bname, j[0], j[1]), jobs))
        out.extend(res)
        print(f"[{bi + 1}/{len(bl)}] {bname}: {len(res)} generaciones · total {len(out)} · {int(time.time() - t0)} s", flush=True)
        os.makedirs(os.path.dirname(OUT) or ".", exist_ok=True)
        with open(OUT, "w", encoding="utf-8") as f:
            json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print("Hecho", len(out), "registros en", OUT)


if __name__ == "__main__":
    main()
