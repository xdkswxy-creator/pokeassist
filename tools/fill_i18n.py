# -*- coding: utf-8 -*-
"""给缺少中文名的形态补上翻译（来自 PokeAPI 的 pokemon-form）。"""
import json, os, sys, time, urllib.request, urllib.parse
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
I18N = os.path.join(DATA, "i18n.zh.json")
UA = {"User-Agent": "pokeassist/1.0 (personal offline helper)"}


def get(url, tries=3):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=12) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception:
            time.sleep(0.4 * (i + 1))
    return None


def slug_of(showdown_name):
    s = showdown_name.lower().replace(" ", "-").replace(".", "").replace("'", "")
    return s


def zh_from_form(slug):
    d = get(f"https://pokeapi.co/api/v2/pokemon-form/{slug}")
    if not d:
        return None
    for n in d.get("form_names") or []:
        if (n.get("language") or {}).get("name") in ("zh-hans", "zh-Hans"):
            return n.get("name")
    # 有些形态在 form_names 里没有中文，退回基础种的中文名 + 形态名
    return None


def zh_from_pokemon(slug):
    d = get(f"https://pokeapi.co/api/v2/pokemon/{slug}")
    if not d:
        return None
    sp = (d.get("species") or {}).get("url")
    if not sp:
        return None
    sd = get(sp)
    if not sd:
        return None
    for n in sd.get("names") or []:
        if (n.get("language") or {}).get("name") in ("zh-hans", "zh-Hans"):
            base = n.get("name")
            form = d.get("name", "")
            extra = form[len(sd.get("name", "")):] if form.startswith(sd.get("name", "")) else ""
            return (base, extra)
    return None


def main():
    with open(I18N, encoding="utf-8") as f:
        i18n = json.load(f)
    with open(os.path.join(DATA, "gen5", "species.json"), encoding="utf-8") as f:
        species = json.load(f)
    zh = i18n.setdefault("species", {})
    missing = [k for k in species if k not in zh]
    print("missing", len(missing))
    if not missing:
        return

    def work(sid):
        name = species[sid].get("name", sid)
        slug = slug_of(name)
        got = zh_from_form(slug)
        if got:
            return sid, got
        alt = zh_from_pokemon(slug)
        if alt:
            base, extra = alt
            return sid, base if not extra else base
        return sid, None

    done = 0
    with ThreadPoolExecutor(max_workers=8) as ex:
        for sid, name in ex.map(work, missing):
            if name:
                zh[sid] = name
                done += 1
                print(f"  {sid} -> {name}")
    with open(I18N, "w", encoding="utf-8") as f:
        json.dump(i18n, f, ensure_ascii=False, separators=(",", ":"))
    print(f"filled {done}/{len(missing)}")
    still = [k for k in species if k not in zh]
    print("still missing", len(still), still[:20])


if __name__ == "__main__":
    main()
