# -*- coding: utf-8 -*-
"""Build a Gen 5 (PokeMMO) subset from the trimmed Gen 9 data."""
import json, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
OUT = os.path.join(DATA, "gen5")
os.makedirs(OUT, exist_ok=True)


def load(name):
    with open(os.path.join(DATA, name + ".json"), encoding="utf-8") as f:
        return json.load(f)


def dump(name, obj):
    p = os.path.join(OUT, name + ".json")
    with open(p, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
    print(f"wrote {name}.json {os.path.getsize(p)/1024:.0f} KB ({len(obj)})")


# Gen 5 national dex ends at 649
GEN5_MAX_SPECIES = 649
# Gen 5 moves end at 559 (Freeze Shock / Ice Burn)
GEN5_MAX_MOVES = 559
# Gen 5 abilities end at 164 (Light Metal)
GEN5_MAX_ABILITIES = 164

species = load("species")
moves = load("moves")
abilities = load("abilities")
items = load("items")
typechart = load("typechart")

# ---- 形态过滤 ----
# 只保留第五世代就存在的形态（清洗洛托姆、代欧奇希斯、三云神兽灵兽形态等）。
# 超级进化 / 极巨化 / 阿罗拉 / 伽勒尔 / 洗翠 / 帕底亚 都是第六世代以后的东西。
BAD_FORME = (
    "Mega", "Gmax", "Alola", "Galar", "Hisui", "Paldea", "Totem",
    "Cosplay", "Starter", "Partner", "Primal", "Eternamax", "Cap", "-Z",
    # 皮卡丘换装（第六世代以后的活动形态）
    "Original", "Hoenn", "Sinnoh", "Unova", "Kalos", "World",
    "Rock-Star", "Belle", "Pop-Star", "PhD", "Libre", "Spiky-eared",
)


def forme_ok(v):
    forme = v.get("forme") or ""
    if not forme:
        return True
    return not any(bad in forme for bad in BAD_FORME)


sp5 = {k: v for k, v in species.items()
       if 0 < v.get("num", 0) <= GEN5_MAX_SPECIES
       and v.get("isNonstandard") not in ("CAP", "Custom", "LGPE")
       and forme_ok(v)}
mv5 = {k: v for k, v in moves.items()
       if 0 < v.get("num", 0) <= GEN5_MAX_MOVES
       and v.get("type") != "Fairy"
       and v.get("isNonstandard") not in ("CAP", "Custom")}
ab5 = {k: v for k, v in abilities.items()
       if 0 < v.get("num", 0) <= GEN5_MAX_ABILITIES}
# 道具：去掉超级进化石（megaEvolves）和第六世代以后才有的东西
it5 = {k: v for k, v in items.items()
       if v.get("isNonstandard") not in ("CAP", "Custom", "Future")
       and not v.get("megaEvolves")}

# ---- Gen 5 type chart: no Fairy; Steel resists Dark and Ghost ----
tc = {atk: dict(row) for atk, row in typechart.items() if atk != "Fairy"}
for row in tc.values():
    row.pop("Fairy", None)
for atk in ("Dark", "Ghost"):
    if atk in tc:
        tc[atk]["Steel"] = 2  # resisted
# sanity: every attacking type must exist as a key
assert "Fairy" not in tc

# ---- learnsets limited to Gen 5 sources ----
raw_path = os.path.join(ROOT, "tools", "raw", "learnsets.json")
with open(raw_path, encoding="utf-8") as f:
    raw_ls = json.load(f)
ls5 = {}
for sid, rec in raw_ls.items():
    if sid not in sp5:
        continue
    learn = rec.get("learnset") or {}
    keep = []
    for mv, srcs in learn.items():
        if mv not in mv5:
            continue
        if any(str(s).startswith("5") for s in srcs):
            keep.append(mv)
    if keep:
        ls5[sid] = sorted(keep)

dump("species", sp5)
dump("moves", mv5)
dump("abilities", ab5)
dump("items", it5)
print("typechart 由 tools/make_typechart.py 单独生成，这里不覆盖")
dump("learnsets", ls5)
print("gen5 species", len(sp5), "moves", len(mv5), "abilities", len(ab5), "learnsets", len(ls5))
