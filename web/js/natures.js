// Natures: 25 total. value = [boosted stat, lowered stat] or null.
export const NATURES = {
  hardy: null, docile: null, serious: null, bashful: null, quirky: null,
  lonely: ['atk', 'def'], brave: ['atk', 'spe'], adamant: ['atk', 'spa'], naughty: ['atk', 'spd'],
  bold: ['def', 'atk'], relaxed: ['def', 'spe'], impish: ['def', 'spa'], lax: ['def', 'spd'],
  timid: ['spe', 'atk'], hasty: ['spe', 'def'], jolly: ['spe', 'spa'], naive: ['spe', 'spd'],
  modest: ['spa', 'atk'], mild: ['spa', 'def'], quiet: ['spa', 'spe'], rash: ['spa', 'spd'],
  calm: ['spd', 'atk'], gentle: ['spd', 'def'], sassy: ['spd', 'spe'], careful: ['spd', 'spa'],
};

export const NATURE_ZH = {
  hardy: '勤奋', docile: '坦率', serious: '认真', bashful: '害羞', quirky: '浮躁',
  lonely: '孤僻', brave: '勇敢', adamant: '固执', naughty: '顽皮',
  bold: '大胆', relaxed: '悠闲', impish: '淘气', lax: '乐天',
  timid: '胆小', hasty: '急躁', jolly: '爽朗', naive: '天真',
  modest: '内敛', mild: '慢吞吞', quiet: '冷静', rash: '马虎',
  calm: '温和', gentle: '温顺', sassy: '自大', careful: '慎重',
};

export const STAT_ZH = { hp: 'HP', atk: '攻击', def: '防御', spa: '特攻', spd: '特防', spe: '速度' };

export function natureMod(nature, stat) {
  const n = NATURES[nature];
  if (!n) return 1;
  if (n[0] === stat) return 1.1;
  if (n[1] === stat) return 0.9;
  return 1;
}
