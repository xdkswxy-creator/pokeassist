# -*- coding: utf-8 -*-
"""按 PokeAPI 的属性相克关系生成第五世代的 typechart.json。
第五世代没有妖精系，且钢抗恶/鬼（第六世代起取消）。"""
import json, os, sys, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'data', 'gen5', 'typechart.json')
BASE = 'https://pokeapi.co/api/v2/type/%d'
NAMES = ['Normal','Fighting','Flying','Poison','Ground','Rock','Bug','Ghost','Steel',
         'Fire','Water','Grass','Electric','Psychic','Ice','Dragon','Dark']  # 1..17, 无妖精

def get(i):
    req = urllib.request.Request(BASE % i, headers={'User-Agent': 'pokeassist/1.0'})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode('utf-8'))

chart = {n: {} for n in NAMES}
for i, name in enumerate(NAMES, start=1):
    d = get(i)
    rel = d['damage_relations']
    for t in rel['double_damage_to']:
        nm = t['name'].capitalize()
        if nm in chart:
            chart[name][nm] = 2
    for t in rel['half_damage_to']:
        nm = t['name'].capitalize()
        if nm in chart:
            chart[name][nm] = 0.5
    for t in rel['no_damage_to']:
        nm = t['name'].capitalize()
        if nm in chart:
            chart[name][nm] = 0
    if name == 'Normal':
        print('fetched', i, name, 'relations', len(rel['double_damage_to']), len(rel['half_damage_to']), len(rel['no_damage_to']))

# 第五世代修正：钢抗恶、钢抗鬼
chart['Dark']['Steel'] = 0.5
chart['Ghost']['Steel'] = 0.5

def eff(a, d):
    return chart[a].get(d, 1)

checks = [
    ('Fire','Grass',2), ('Water','Fire',2), ('Fighting','Normal',2), ('Fighting','Ghost',0),
    ('Normal','Ghost',0), ('Ground','Flying',0), ('Electric','Ground',0), ('Ground','Electric',2),
    ('Ice','Dragon',2), ('Dark','Steel',0.5), ('Ghost','Steel',0.5), ('Steel','Dark',1),
    ('Psychic','Dark',0), ('Poison','Steel',0), ('Rock','Flying',2), ('Grass','Fire',0.5),
]
bad = [(a,d,e,eff(a,d)) for a,d,e in checks if eff(a,d) != e]
print('fairy present:', 'Fairy' in chart, '| attack types:', len(chart))
if bad:
    print('FAILED CHECKS:', bad); sys.exit(1)
print('all checks passed')

with open(OUT, 'w', encoding='utf-8') as f:
    json.dump(chart, f, ensure_ascii=False, separators=(',', ':'))
print('wrote', OUT, os.path.getsize(OUT), 'bytes')
