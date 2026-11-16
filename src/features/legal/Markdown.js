// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { Fragment, useMemo } from 'react';
import { Linking, StyleSheet, Text, View } from 'react-native';
import { useColors } from '../../theme/colors';
import { safeWebLink } from '../events/model/eventModel';
import { parseMarkdown } from './parseMarkdown';

// The few Markdown forms the legal documents use (legal/*.md): headings, paragraphs,
// lists, tables, quotes, **bold** and [links](https://…). Tables become one block per
// row, each cell under its column's name: readable on a phone.

const INLINE = /(\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g;

function Inline({ text, styles }) {
  const parts = text.split(INLINE).filter(Boolean);
  return parts.map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <Text key={index} style={styles.bold}>{part.slice(2, -2)}</Text>;
    }
    const link = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (link) {
      const url = safeWebLink(link[2]);
      return (
        <Text key={index} style={url ? styles.link : null} accessibilityRole={url ? 'link' : undefined} onPress={url ? () => Linking.openURL(url).catch(() => {}) : undefined}>
          {link[1]}
        </Text>
      );
    }
    return <Fragment key={index}>{part}</Fragment>;
  });
}

export function Markdown({ source }) {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const blocks = useMemo(() => parseMarkdown(source), [source]);
  return (
    <View style={styles.document}>
      {blocks.map((block, index) => {
        switch (block.kind) {
          case 'heading':
            return (
              <Text key={index} style={styles[`h${block.level}`]} accessibilityRole="header">
                <Inline text={block.text} styles={styles} />
              </Text>
            );
          case 'list':
            return (
              <View key={index} style={styles.list}>
                {block.items.map((item, itemIndex) => (
                  <View key={itemIndex} style={[styles.item, item.depth ? styles.nested : null]}>
                    <Text style={styles.bullet}>•</Text>
                    <Text style={styles.body}><Inline text={item.text} styles={styles} /></Text>
                  </View>
                ))}
              </View>
            );
          case 'table':
            return (
              <View key={index} style={styles.table}>
                {block.rows.map((row, rowIndex) => (
                  <View key={rowIndex} style={[styles.row, rowIndex === block.rows.length - 1 && styles.lastRow]}>
                    <Text style={styles.rowTitle}><Inline text={row[0] ?? ''} styles={styles} /></Text>
                    {row.slice(1).map((cell, cellIndex) => (
                      <Text key={cellIndex} style={styles.body}>
                        {block.header.length > 2 ? <Text style={styles.cellLabel}>{block.header[cellIndex + 1]}: </Text> : null}
                        <Inline text={cell} styles={styles} />
                      </Text>
                    ))}
                  </View>
                ))}
              </View>
            );
          case 'quote':
            return (
              <View key={index} style={styles.quote}>
                <Text style={styles.body}><Inline text={block.text} styles={styles} /></Text>
              </View>
            );
          default:
            return (
              <Text key={index} style={styles.body}>
                <Inline text={block.text} styles={styles} />
              </Text>
            );
        }
      })}
    </View>
  );
}

const createStyles = (colors) => StyleSheet.create({
  document: { gap: 12 },
  h1: { fontSize: 26, fontWeight: '800', color: colors.active, marginBottom: 4 },
  h2: { fontSize: 19, fontWeight: '700', color: colors.active, marginTop: 14 },
  h3: { fontSize: 16, fontWeight: '700', color: colors.active, marginTop: 6 },
  body: { flex: 1, fontSize: 15, lineHeight: 22, color: colors.active },
  bold: { fontWeight: '700' },
  link: { textDecorationLine: 'underline' },
  list: { gap: 6 },
  item: { flexDirection: 'row', gap: 8 },
  nested: { marginLeft: 18 },
  bullet: { fontSize: 15, lineHeight: 22, color: colors.inactive },
  table: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, overflow: 'hidden' },
  row: { padding: 12, gap: 4, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  lastRow: { borderBottomWidth: 0 },
  rowTitle: { fontSize: 15, fontWeight: '600', color: colors.active },
  cellLabel: { color: colors.inactive },
  quote: { borderLeftWidth: 3, borderLeftColor: colors.border, paddingLeft: 12 },
});
