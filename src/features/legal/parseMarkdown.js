// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// The few Markdown forms the legal documents use (legal/*.md), as blocks Markdown.js
// draws: headings, paragraphs, lists (one level of nesting), tables and quotes.

const cells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());

// Markdown → blocks: { kind, text?, level?, items?, header?, rows? }
export function parseMarkdown(source) {
  const blocks = [];
  const lines = source.replace(/\r/g, '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2] });
      continue;
    }
    if (line.trim().startsWith('|')) {
      const table = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) table.push(lines[i++]);
      i--;
      const [header, , ...rows] = table;
      blocks.push({ kind: 'table', header: cells(header), rows: rows.map(cells) });
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && (/^\s*[-*]\s+/.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) {
        const item = lines[i].match(/^(\s*)[-*]\s+(.*)$/);
        if (item) items.push({ depth: item[1].length >= 2 ? 1 : 0, text: item[2] });
        else items[items.length - 1].text += ` ${lines[i].trim()}`;
        i++;
      }
      i--;
      blocks.push({ kind: 'list', items });
      continue;
    }
    if (line.startsWith('>')) {
      const quote = [];
      while (i < lines.length && lines[i].startsWith('>')) quote.push(lines[i++].replace(/^>\s?/, ''));
      i--;
      blocks.push({ kind: 'quote', text: quote.join(' ') });
      continue;
    }
    const paragraph = [line.trim()];
    while (i + 1 < lines.length && lines[i + 1].trim() && !/^(#|\||>|\s*[-*]\s)/.test(lines[i + 1])) paragraph.push(lines[++i].trim());
    blocks.push({ kind: 'paragraph', text: paragraph.join(' ') });
  }
  return blocks;
}
