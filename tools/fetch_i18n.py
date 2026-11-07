# -*- coding: utf-8 -*-
"""Fetch Simplified-Chinese names from PokeAPI and build en->zh maps."""
import json, os, re, sys, time, urllib.request
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "i18n.zh.json")
UA = {"User-Agent": "pokeassist/0.1 (data build)"}


def norm(s):
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


def get(url, tries=3):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read())
        except Exception:
            time.sleep(1 + i)
    return None


def names_of(obj):
    """Return {'en':..., 'zh':..., 'zh_tw':...} from a PokeAPI names array."""
    out = {}
    for n in obj.get("names") or []:
        lang = ((n.get("language") or {}).get("name") or "").lower()
        if lang == "en":
            out["en"] = n.get("name")
        elif lang == "zh-hans":
            out["zh"] = n.get("name")
        elif lang == "zh-hant":
            out.setdefault("zh_tw", n.get("name"))
    return out


def collect(kind, endpoint, ids, offset=0):
    base = "https://pokeapi.co/api/v2/"
    results = {}

    def one(i):
        obj = get(f"{base}{endpoint}/{i}")
        if not obj:
            return None
        nm = names_of(obj)
        if not nm.get("en"):
            return None
        zh = nm.get("zh") or nm.get("zh_tw")
        if not zh:
            return None
        return (norm(nm["en"]), zh)

    done = 0
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=12) as ex:
        for res in ex.map(one, ids):
            done += 1
            if res:
                results[res[0]] = res[1]
            if done % 200 == 0:
                print(f"  {kind}: {done}/{len(ids)} ok={len(results)} {time.time()-t0:.0f}s", flush=True)
    print(f"  {kind}: done {len(results)} entries in {time.time()-t0:.0f}s", flush=True)
    return results


def main():
    out = {}
    if os.path.exists(OUT):
        with open(OUT, encoding="utf-8") as f:
            out = json.load(f)

    jobs = [
        ("species", "pokemon-species", list(range(1, 1026))),
        ("moves", "move", list(range(1, 1001))),
        ("abilities", "ability", list(range(1, 321))),
        ("items", "item", list(range(1, 2206))),
    ]
    for kind, ep, ids in jobs:
        if kind in out and len(out[kind]) > len(ids) * 0.6:
            print(f"skip {kind} (already {len(out[kind])})", flush=True)
            continue
        out[kind] = collect(kind, ep, ids)
        with open(OUT, "w", encoding="utf-8") as f:
            json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
        print(f"saved i18n.zh.json ({os.path.getsize(OUT)/1024:.0f} KB)", flush=True)


if __name__ == "__main__":
    main()
