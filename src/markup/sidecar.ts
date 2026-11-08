import { Card, cards } from './cards';
import { TextEdit, commentMarkup } from './edits';
import { Parsed } from './parse';

export function sidecarEnabled(fileName: string, extensions: readonly string[]): boolean {
    const name = fileName.toLowerCase();
    if (name.endsWith('.review') || !Array.isArray(extensions)) {
        return false;
    }
    return extensions.filter(e => typeof e === 'string').some(e => e === '*' || name.endsWith(e.startsWith('.') ? e.toLowerCase() : `.${e.toLowerCase()}`));
}

// What a new comment quotes: the selection, or the current line without its indentation. A blank line quotes nothing.
export function quoteAt(source: string, from: number, to: number): { from: number; to: number; quote: string } {
    if (from !== to) {
        return { from, to, quote: source.slice(from, to) };
    }
    const start = source.lastIndexOf('\n', from - 1) + 1;
    const newline = source.indexOf('\n', from);
    const line = source.slice(start, newline === -1 ? source.length : newline);
    const quote = line.trim();
    if (!quote) {
        return { from: 0, to: 0, quote: '' };
    }
    const lineFrom = start + line.length - line.trimStart().length;
    return { from: lineFrom, to: lineFrom + quote.length, quote };
}

// Anchors can overlap in a sidecar. A cursor opens the smallest one around it; a selection opens only an anchor it equals.
export function cardAt(shown: Card[], from: number, to: number): Card | undefined {
    if (from !== to) {
        return shown.find(c => c.from === from && c.to === to);
    }
    return shown.filter(c => c.from < from && from < c.to).sort((a, b) => (a.to - a.from) - (b.to - b.from))[0];
}

export function addEntry(text: string, quote: string, line: number | null, body: string, author: string, date: string): TextEdit {
    if (quote.includes('==}')) {
        throw new Error('Selection contains "==}", which would break the mark.');
    }
    const anchor = quote ? `{line="${line}"==${quote.replace(/\r\n/g, '\n')}==}` : '';
    const separator = text === '' || text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n';
    return { from: text.length, to: text.length, insert: `${separator}${anchor}${commentMarkup(body, author, date)}\n`, expected: '' };
}

export function removeEntry(text: string, entry: { from: number; to: number }): TextEdit {
    let from = entry.from;
    const to = entry.to + text.slice(entry.to).match(/^(\r?\n)*/)![0].length;
    if (to === text.length && from > 0) {
        from = Math.min(from, text.slice(0, from).trimEnd().length + 1);
    }
    return { from, to, insert: '', expected: text.slice(from, to) };
}

// The edit to the source that an Accept makes. Refused whenever the place in the source would be a guess.
export function acceptEdit(parsed: Parsed, card: Card, source: string): TextEdit {
    if (card.orphaned) {
        throw new Error('The code of this suggestion is no longer in the file.');
    }
    if (card.ambiguous) {
        throw new Error('This code appears more than once and none of the copies is on the line the suggestion names.');
    }
    const node = parsed.nodes[card.suggestion!];
    // The first `~>` splits old from new, so a quote holding one is cut in the wrong place.
    if (node.kind === 'substitution' && node.text.includes('~>')) {
        throw new Error('This replacement contains "~>", so its old and new text cannot be told apart. Apply it by hand.');
    }
    const insert = node.kind === 'substitution' ? node.text.replace(/\r?\n/g, source.includes('\r\n') ? '\r\n' : '\n') : '';
    return { from: card.from, to: card.to, insert, expected: source.slice(card.from, card.to) };
}

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
        const anchor = card.thread !== null ? parsed.threads[card.thread].anchorIndex : card.suggestion;
        if (anchor === null) {
            return { ...card, from: 0, to: 0 };
        }
        const node = parsed.nodes[anchor];
        // A bare addition has no source text to attach to.
        const quote = node.kind === 'substitution' ? node.oldText! : node.kind === 'addition' ? '' : node.text;
        const match = findQuote(source, quote, node.line);
        if (!match) {
            return { ...card, from: 0, to: 0, orphaned: true, anchor: `Orphaned: ${card.anchor}` };
        }
        return { ...card, from: match.from, to: match.to, ambiguous: match.count > 1 && !match.onLine };
    }).sort((a, b) => a.from - b.from);
}

// Finds an entry by its text, because offsets go stale when an agent writes to the sidecar during a save.
export function entryOf(text: string, raw: string): { from: number; to: number } {
    const from = text.indexOf(raw);
    if (from === -1) {
        throw new Error('The review file changed and this entry is no longer in it.');
    }
    return { from, to: from + raw.length };
}
