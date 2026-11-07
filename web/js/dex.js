// Load the trimmed data files into a dex object (works in Node and browser).
// The dex is Gen 5 only: no Fairy type, Steel still resists Dark/Ghost.

export async function loadDexNode(fs, base, i18nBase) {
  const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
  let zh = {};
  try {
    zh = read((i18nBase || base) + '/i18n.zh.json');
  } catch (e) {
    zh = {};
  }
  return finishDex({
    species: read(base + '/species.json'),
    moves: read(base + '/moves.json'),
    abilities: read(base + '/abilities.json'),
    items: read(base + '/items.json'),
    typechart: read(base + '/typechart.json'),
    learnsets: read(base + '/learnsets.json'),
    zh,
  });
}

// Attach the map key as `.id`, which the engine expects on every entry.
function finishDex(dex) {
  for (const [id, v] of Object.entries(dex.moves)) if (!v.id) v.id = id;
  for (const [id, v] of Object.entries(dex.species)) if (!v.id) v.id = id;
  for (const [id, v] of Object.entries(dex.abilities)) if (!v.id) v.id = id;
  for (const [id, v] of Object.entries(dex.items)) if (!v.id) v.id = id;
  return dex;
}

export async function loadDexBrowser(base = 'data/gen5', i18nBase = 'data') {
  const get = async (url) => {
    const r = await fetch(url);
    if (!r.ok) throw new Error(url + ' -> ' + r.status);
    return r.json();
  };
  const [species, moves, abilities, items, typechart, learnsets] = await Promise.all([
    get(base + '/species.json'),
    get(base + '/moves.json'),
    get(base + '/abilities.json'),
    get(base + '/items.json'),
    get(base + '/typechart.json'),
    get(base + '/learnsets.json'),
  ]);
  let zh = {};
  try {
    zh = await get(i18nBase + '/i18n.zh.json');
  } catch (e) {
    zh = {};
  }
  return finishDex({ species, moves, abilities, items, typechart, learnsets, zh });
}

// ------------------------------------------------------------------ helpers

export function speciesName(dex, id) {
  return (dex.zh && dex.zh.species && dex.zh.species[id]) || (dex.species[id] ? dex.species[id].name : id);
}

export function moveName(dex, id) {
  return (dex.zh && dex.zh.moves && dex.zh.moves[id]) || (dex.moves[id] ? dex.moves[id].name : id);
}

export function abilityName(dex, id) {
  return (dex.zh && dex.zh.abilities && dex.zh.abilities[id]) || (dex.abilities[id] ? dex.abilities[id].name : id);
}

export function itemName(dex, id) {
  return (dex.zh && dex.zh.items && dex.zh.items[id]) || (dex.items[id] ? dex.items[id].name : id);
}
