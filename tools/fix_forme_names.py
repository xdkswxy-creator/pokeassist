# -*- coding: utf-8 -*-
"""修整形态中文名：把「灵兽形态」这种只有形态名补成「土地云灵兽形态」，并补阿尔宙斯。"""
import json, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
I18N = os.path.join(DATA, "i18n.zh.json")

TYPE_ZH = {
    "normal": "一般", "fire": "火", "water": "水", "electric": "电", "grass": "草", "ice": "冰",
    "fighting": "格斗", "poison": "毒", "ground": "地面", "flying": "飞行", "psychic": "超能",
    "bug": "虫", "rock": "岩石", "ghost": "幽灵", "dragon": "龙", "dark": "恶", "steel": "钢",
    "fairy": "妖精",
}

with open(I18N, encoding="utf-8") as f:
    i18n = json.load(f)
with open(os.path.join(DATA, "gen5", "species.json"), encoding="utf-8") as f:
    species = json.load(f)
zh = i18n.setdefault("species", {})

name2id = {}
for sid, v in species.items():
    name2id[v.get("name", "").lower()] = sid

fixed = 0
for sid, v in species.items():
    if sid not in zh:
        continue
    full = v.get("name", "")
    if "-" not in full:
        continue
    base_name = full.split("-")[0]
    base_id = name2id.get(base_name.lower())
    base_zh = zh.get(base_id) if base_id else None
    if not base_zh:
        continue
    cur = zh[sid]
    if base_zh not in cur:
        zh[sid] = base_zh + cur
        fixed += 1
        print(f"  {sid}: {cur} -> {zh[sid]}")

# 阿尔宙斯 17 种属性形态：PokeAPI 没有中文形态名，直接拼
arceus_zh = "阿尔宙斯"
for t, tz in TYPE_ZH.items():
    sid = "arceus" + t
    if sid in species:
        zh[sid] = f"{arceus_zh}（{tz}）"

with open(I18N, "w", encoding="utf-8") as f:
    json.dump(i18n, f, ensure_ascii=False, separators=(",", ":"))

still = [k for k in species if k not in zh]
print("fixed", fixed, "still missing", len(still), still[:20])
