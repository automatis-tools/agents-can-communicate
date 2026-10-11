import {stripVTControlCharacters} from 'node:util';

/** Status payload strings are data, never terminal control sequences. */
export const footerText = value => typeof value==='string'
  ? stripVTControlCharacters(value).replace(/[\p{Cc}\p{Cf}]/gu,' ').slice(0,160).trim() : '';
export function footerCwd(value) {
 const text=footerText(value), parts=text.split(/[\\/]/).filter(Boolean);
 return parts.length>3?`…/${parts.slice(-3).join('/')}`:text;
}
export function indicatorGlyph(report) {
 const rgb=report.health==='ready'?'44;122;57':report.health==='problem'?'150;108;30':'102;102;102';
 return report.label.replace(/^ACC ([●!…])/u,(_,glyph)=>`ACC \x1b[22;1;38;2;${rgb}m${glyph}\x1b[22;39m`);
}
