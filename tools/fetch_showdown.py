# -*- coding: utf-8 -*-
"""Download Pokemon Showdown data files and produce compact JSON for the app."""
import json, os, subprocess, sys, time, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "tools", "raw")
DATA = os.path.join(ROOT, "data")
os.makedirs(RAW, exist_ok=True)
os.makedirs(DATA, exist_ok=True)

UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36"}
BASE = "https://play.pokemonshowdown.com/"

FILES = {
    "pokedex.json": "pokedex",
    "moves.json": "moves",
    "abilities.js": "abilities",
    "items.js": "items",
    "typechart.js": "typechart",
    "learnsets.json": "learnsets",
}

NODE = r"C:\Users\ZhuanZ\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"


def fetch(name, tries=3):
    dst = os.path.join(RAW, name)
    if os.path.exists(dst) and os.path.getsize(dst) > 1000:
        return dst
    for i in range(tries):
        try:
            req = urllib.request.Request(BASE + "data/" + name, headers=UA)
            with urllib.request.urlopen(req, timeout=60) as r:
                body = r.read()
            with open(dst, "wb") as f:
                f.write(body)
            print(f"  downloaded {name}: {len(body)} bytes")
            return dst
        except Exception as e:
            print(f"  retry {i+1} {name}: {e}")
            time.sleep(2)
    raise SystemExit(f"failed to download {name}")


def load_json(name):
    """Return parsed dict for whichever raw file backs `name`."""
    js = os.path.join(RAW, name + ".js")
    pj = os.path.join(RAW, name + ".json")
    if os.path.exists(pj):
        with open(pj, encoding="utf-8") as f:
            return json.load(f)
    out = os.path.join(RAW, name + ".converted.json")
    subprocess.run([NODE, os.path.join(ROOT, "tools", "js2json.cjs"), js, out], check=True)
    with open(out, encoding="utf-8") as f:
        return json.load(f)


def main():
    print("[1/4] downloading")
    for f in FILES:
        fetch(f)

    print("[2/4] parsing")
    dex = load_json("pokedex")
    moves = load_json("moves")
    abilities = load_json("abilities")
    items = load_json("items")
    typechart = load_json("typechart")
    learnsets = load_json("learnsets")

    print(f"  species={len(dex)} moves={len(moves)} abilities={len(abilities)} items={len(items)}")

    print("[3/4] trimming")

    # ---- species ----
    sp_out = {}
    for sid, s in dex.items():
        if s.get("isNonstandard") in ("CAP", "Custom"):
            continue
        if s.get("cosmeticFormes"):
            pass
        sp_out[sid] = {
            "num": s.get("num", 0),
            "name": s.get("name", sid),
            "types": s.get("types", []),
            "baseStats": {k: s.get("baseStats", {}).get(k, 0) for k in ("hp", "atk", "def", "spa", "spd", "spe")},
            "abilities": s.get("abilities", {}),
            "weight": s.get("weightkg", 0),
            "gen": s.get("gen", 0),
        }
        for k in ("isNonstandard", "forme", "baseSpecies", "otherFormes", "requiredItem", "requiredMove", "changesFrom"):
            if k in s:
                sp_out[sid][k] = s[k]

    # ---- moves ----
    keep = ["num", "name", "type", "category", "basePower", "accuracy", "pp", "priority",
            "flags", "target", "critRatio", "willCrit", "drain", "recoil", "heal",
            "multihit", "status", "volatileStatus", "boosts", "self", "secondary",
            "weather", "terrain", "sideCondition", "forceSwitch", "selfSwitch",
            "ignoreImmunity", "ohko", "breaksProtect", "thawsTarget", "defrost",
            "selfBoost", "sleepUsable", "isNonstandard", "zMove", "maxMove", "damage",
            "desc", "shortDesc"]
    mv_out = {}
    for mid, m in moves.items():
        if m.get("isNonstandard") in ("CAP", "Custom"):
            continue
        d = {}
        for k in keep:
            if k in m:
                v = m[k]
                if k in ("desc", "shortDesc") and isinstance(v, str):
                    v = v[:220]
                d[k] = v
        if "name" not in d:
            continue
        mv_out[mid] = d

    # ---- abilities / items ----
    ab_out = {}
    for aid, a in abilities.items():
        ab_out[aid] = {k: a[k] for k in ("num", "name", "rating", "shortDesc", "isNonstandard") if k in a}
    it_out = {}
    for iid, it in items.items():
        it_out[iid] = {k: it[k] for k in ("num", "name", "isNonstandard", "megaStone", "itemUser",
                                          "shortDesc", "naturalGift", "fling") if k in it}

    # ---- typechart: damageTaken 0=neutral 1=weak 2=resist 3=immune ----
    tc_out = {}
    for atk, row in typechart.items():
        dt = row.get("damageTaken", {})
        tc_out[atk] = {k: v for k, v in dt.items()}

    # ---- learnsets: keep gen9 entries only ----
    ls_out = {}
    for sid, s in learnsets.items():
        ls = s.get("learnset") or {}
        g9 = sorted({mv for mv, srcs in ls.items() if any(str(x).startswith("9") for x in srcs)})
        if g9:
            ls_out[sid] = g9

    def dump(name, obj):
        p = os.path.join(DATA, name + ".json")
        with open(p, "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
        print(f"  wrote {name}.json  {os.path.getsize(p)/1024:.0f} KB  (%d entries)" % len(obj))

    dump("species", sp_out)
    dump("moves", mv_out)
    dump("abilities", ab_out)
    dump("items", it_out)
    dump("typechart", tc_out)
    dump("learnsets", ls_out)
    print("[4/4] done")


if __name__ == "__main__":
    main()

