import type { Profession } from '../../../../src/domain/market.js';
import type { MarketRow } from './marketRows.js';

export interface MarketSection { key: string; title: string; rows: MarketRow[]; }

export function marketSections(rows: MarketRow[], professions: Profession[], preferred: string[], downloaded: boolean): MarketSection[] {
  if (downloaded) return rows.length ? [{ key: 'downloaded', title: '已下载', rows }] : [];
  const recommended = rows.filter(row => row.preset.professions.some(id => preferred.includes(id)));
  const assigned = new Set(recommended.map(row => row.key));
  const sections: MarketSection[] = recommended.length ? [{ key: 'recommended', title: '为你推荐', rows: recommended }] : [];
  for (const profession of professions) {
    const categoryRows = rows.filter(row => !assigned.has(row.key) && row.preset.professions.includes(profession.id));
    if (!categoryRows.length) continue;
    categoryRows.forEach(row => assigned.add(row.key));
    sections.push({ key: profession.id, title: profession.name, rows: categoryRows });
  }
  const other = rows.filter(row => !assigned.has(row.key));
  if (other.length) sections.push({ key: 'other', title: '其他预设', rows: other });
  return sections;
}
