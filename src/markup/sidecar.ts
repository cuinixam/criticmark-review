import { Card, cards } from './cards';
import { Parsed } from './parse';

function lineOf(text: string, pos: number): number {
    return text.slice(0, pos).split('\n').length;
}

// A quote may be LF while the source is CRLF. Returns the match nearest to `line`.
export function findQuote(source: string, quote: string, line: number | null): { from: number; to: number; count: number; onLine: boolean } | null {
    if (!quote) {
        return null;
    }
    const pattern = quote.replace(/\r\n/g, '\n').replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\n/g, '\\r?\\n');
    const matches = [...source.matchAll(new RegExp(pattern, 'g'))].map(m => ({ from: m.index, to: m.index + m[0].length, line: lineOf(source, m.index) }));
    if (matches.length === 0) {
        return null;
    }
    const target = line ?? matches[0].line;
    const best = matches.reduce((a, b) => Math.abs(b.line - target) < Math.abs(a.line - target) ? b : a);
    return { from: best.from, to: best.to, count: matches.length, onLine: best.line === line };
}

// Sidecar cards share the inline `Card`, so reply, edit and resolve keep using the thread indexes into the sidecar.
export function placeCards(parsed: Parsed, source: string): Card[] {
    return cards(parsed).map((card): Card => {
        const entry = { from: card.from, to: card.to };
        const anchor = card.thread !== null ? parsed.threads[card.thread].anchorIndex : card.suggestion;
        if (anchor === null) {
            return { ...card, entry, from: 0, to: 0 };
        }
        const node = parsed.nodes[anchor];
        // A bare addition has no source text to attach to.
        const quote = node.kind === 'substitution' ? node.oldText! : node.kind === 'addition' ? '' : node.text;
        const match = findQuote(source, quote, node.line);
        if (!match) {
            return { ...card, entry, from: 0, to: 0, orphaned: true, anchor: `Orphaned: ${card.anchor}` };
        }
        return { ...card, entry, from: match.from, to: match.to, ambiguous: match.count > 1 && !match.onLine };
    }).sort((a, b) => a.from - b.from);
}
