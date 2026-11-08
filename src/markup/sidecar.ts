import { createHash } from 'crypto';
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

interface Context {
    before: string | null;
    after: string | null;
}

interface Line {
    from: number;
    text: string;
}

export function lineHash(text: string): string {
    return createHash('sha1').update(text.trim()).digest('hex').slice(0, 8);
}

function linesOf(source: string): Line[] {
    let from = 0;
    return source.split('\n').map(text => {
        const line = { from, text };
        from += text.length + 1;
        return line;
    });
}

function around(lines: Line[], first: number, last: number): Context {
    const nearest = (start: number, step: number) => {
        for (let i = start; i >= 0 && i < lines.length; i += step) {
            if (lines[i].text.trim()) {
                return lineHash(lines[i].text);
            }
        }
        return null;
    };
    return { before: nearest(first - 1, -1), after: nearest(last + 1, 1) };
}

function indexOfLine(lines: Line[], pos: number): number {
    let index = 0;
    while (index + 1 < lines.length && lines[index + 1].from <= pos) {
        index++;
    }
    return index;
}

// The place of a new comment: its line, and the lines around it so it can be found again after the code moved.
export function contextAt(source: string, from: number, to: number): Context & { line: number } {
    const lines = linesOf(source);
    const first = indexOfLine(lines, from);
    return { line: first + 1, ...around(lines, first, indexOfLine(lines, to > from ? to - 1 : from)) };
}

function hits(wanted: Context, found: Context): { count: number; all: boolean } {
    const known = (['before', 'after'] as const).filter(side => wanted[side] !== null);
    const count = known.filter(side => wanted[side] === found[side]).length;
    return { count, all: known.length > 0 && count === known.length };
}

// Matching neighbours come first, because the stored line goes stale when the code moves. The line then picks the nearest.
function choose<T extends { line: number; hits: number }>(found: T[], line: number | null): T {
    const top = Math.max(...found.map(f => f.hits));
    const pool = found.filter(f => f.hits === top);
    const target = line ?? pool[0].line;
    return pool.reduce((a, b) => Math.abs(b.line - target) < Math.abs(a.line - target) ? b : a);
}

// A blank line has no text to search for, so only its neighbours can find it again.
export function findBlank(source: string, line: number, context: Context): number | null {
    const lines = linesOf(source);
    if (context.before === null && context.after === null) {
        const exact = lines[line - 1];
        return exact && !exact.text.trim() ? exact.from : null;
    }
    const blanks = lines.flatMap((l, i) => l.text.trim() ? [] : [{ from: l.from, line: i + 1, hits: hits(context, around(lines, i, i)).count }]);
    if (!blanks.some(b => b.hits > 0)) {
        return null;
    }
    return choose(blanks, line).from;
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
        return { from: start, to: start, quote: '' };
    }
    const lineFrom = start + line.length - line.trimStart().length;
    return { from: lineFrom, to: lineFrom + quote.length, quote };
}

// Anchors can overlap in a sidecar. A cursor opens the smallest one around it, or a comment on its blank line; a selection opens only an anchor it equals.
export function cardAt(shown: Card[], from: number, to: number): Card | undefined {
    if (from !== to) {
        return shown.find(c => c.from === from && c.to === to);
    }
    return shown.filter(c => (c.from < from && from < c.to) || (c.from === c.to && c.from === from && from > 0)).sort((a, b) => (a.to - a.from) - (b.to - b.from))[0];
}

export function addEntry(text: string, quote: string, place: (Context & { line: number }) | null, body: string, author: string, date: string): TextEdit {
    if (quote.includes('==}')) {
        throw new Error('Selection contains "==}", which would break the mark.');
    }
    const attributes = !place ? '' : [
        `line="${place.line}"`,
        ...place.before ? [`before="${place.before}"`] : [],
        ...place.after ? [`after="${place.after}"`] : [],
    ].join(' ');
    const comment = commentMarkup(body, author, date);
    const entry = quote ? `{${attributes}==${quote.replace(/\r\n/g, '\n')}==}${comment}` : attributes ? `{${attributes} ${comment.slice(1)}` : comment;
    const separator = text === '' || text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n';
    return { from: text.length, to: text.length, insert: `${separator}${entry}\n`, expected: '' };
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
        throw new Error('This code appears more than once and the suggestion cannot tell which copy it means.');
    }
    const node = parsed.nodes[card.suggestion!];
    // The first `~>` splits old from new, so a quote holding one is cut in the wrong place.
    if (node.kind === 'substitution' && node.text.includes('~>')) {
        throw new Error('This replacement contains "~>", so its old and new text cannot be told apart. Apply it by hand.');
    }
    const insert = node.kind === 'substitution' ? node.text.replace(/\r?\n/g, source.includes('\r\n') ? '\r\n' : '\n') : '';
    return { from: card.from, to: card.to, insert, expected: source.slice(card.from, card.to) };
}

// A quote may be LF while the source is CRLF. `confirmed` means the neighbours of the chosen copy match.
export function findQuote(source: string, quote: string, line: number | null, context: Context = { before: null, after: null }): { from: number; to: number; count: number; onLine: boolean; confirmed: boolean } | null {
    if (!quote) {
        return null;
    }
    const pattern = quote.replace(/\r\n/g, '\n').replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\n/g, '\\r?\\n');
    const lines = linesOf(source);
    let index = 0;
    const matches = [...source.matchAll(new RegExp(pattern, 'g'))].map(m => {
        while (index + 1 < lines.length && lines[index + 1].from <= m.index) {
            index++;
        }
        const result = hits(context, around(lines, index, index + m[0].split('\n').length - 1));
        return { from: m.index, to: m.index + m[0].length, line: index + 1, hits: result.count, all: result.all };
    });
    if (matches.length === 0) {
        return null;
    }
    const best = choose(matches, line);
    return { from: best.from, to: best.to, count: matches.length, onLine: best.line === line, confirmed: best.all };
}

// Sidecar cards share the inline `Card`, so reply, edit and resolve keep using the thread indexes into the sidecar.
export function placeCards(parsed: Parsed, source: string): Card[] {
    return cards(parsed).map((card): Card => {
        const anchor = card.thread !== null ? parsed.threads[card.thread].anchorIndex : card.suggestion;
        if (anchor === null) {
            const root = parsed.nodes[parsed.threads[card.thread!].rootIndex];
            if (root.line === null) {
                return { ...card, from: 0, to: 0 };
            }
            const blank = findBlank(source, root.line, root);
            return blank === null ? { ...card, from: 0, to: 0, orphaned: true, anchor: `Orphaned: ${card.anchor}` } : { ...card, from: blank, to: blank };
        }
        const node = parsed.nodes[anchor];
        // A bare addition has no source text to attach to.
        const quote = node.kind === 'substitution' ? node.oldText! : node.kind === 'addition' ? '' : node.text;
        const match = findQuote(source, quote, node.line, node);
        if (!match) {
            return { ...card, from: 0, to: 0, orphaned: true, anchor: `Orphaned: ${card.anchor}` };
        }
        const hasNeighbours = node.before !== null || node.after !== null;
        return { ...card, from: match.from, to: match.to, ambiguous: match.count > 1 && !(hasNeighbours ? match.confirmed : match.onLine) };
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
