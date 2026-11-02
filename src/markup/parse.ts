// Mirrors the parser of the Obsidian Track Changes plugin 2.0.0, so files round trip.

export type Kind = 'comment' | 'highlight' | 'addition' | 'deletion' | 'substitution' | 'aitext';

export interface MarkupNode {
    kind: Kind;
    from: number;
    to: number;
    raw: string;
    text: string;
    oldText?: string;
    author: string | null;
    date: string | null;
}

export interface Thread {
    rootIndex: number;
    replyIndexes: number[];
    anchorIndex: number | null;
    from: number;
    to: number;
}

export interface Parsed {
    text: string;
    nodes: MarkupNode[];
    threads: Thread[];
}

const ATTR = '[A-Za-z][\\w-]*="[^"{}\\n]*"';
const META = `((?:${ATTR}(?:[ \\t]+${ATTR})*[ \\t]*)?)`;
const BODY = '([\\s\\S]*?)';

const PATTERNS: [Kind, RegExp][] = [
    ['comment', new RegExp(`\\{${META}>>${BODY}<<\\}`, 'g')],
    ['addition', new RegExp(`\\{${META}\\+\\+${BODY}\\+\\+\\}`, 'g')],
    ['deletion', new RegExp(`\\{${META}--${BODY}--\\}`, 'g')],
    ['substitution', new RegExp(`\\{${META}~~${BODY}~>${BODY}~~\\}`, 'g')],
    ['highlight', new RegExp(`\\{${META}==${BODY}==\\}`, 'g')],
    ['aitext', new RegExp(`\\{${META}=\\+${BODY}\\+=\\}`, 'g')],
];

const ATTR_PAIR = /([A-Za-z][\w-]*)="([^"{}\n]*)"/g;
const LEGACY_AUTHOR = /^\s*([A-Za-z][\w.-]{0,29})\s*:\s*/;
const FENCE = /(^|\n)( {0,3})(```+|~~~+)[^\n]*\n[\s\S]*?(?:\n {0,3}\3[ \t]*(?=\r?\n|$)|$)/g;
const INLINE_CODE = /`[^`\n]+`/g;

function readAttrs(meta: string): Record<string, string> {
    const attrs: Record<string, string> = {};
    for (const m of meta.matchAll(ATTR_PAIR)) {
        const name = m[1].toLowerCase();
        const value = m[2].trim();
        if (value !== '' && !(name in attrs)) {
            attrs[name] = value;
        }
    }
    return attrs;
}

// Indented code: a run of lines indented by 4 spaces or a tab that starts after a blank line.
function indentedCode(text: string, fences: [number, number][]): [number, number][] {
    const inFence = (pos: number) => fences.some(([a, b]) => pos >= a && pos < b);
    const ranges: [number, number][] = [];
    let pos = 0;
    let afterBlank = true;
    let start = -1;
    while (pos <= text.length) {
        const newline = text.indexOf('\n', pos);
        const end = newline === -1 ? text.length : newline;
        const line = text.slice(pos, end);
        if (inFence(pos)) {
            if (start >= 0) {
                ranges.push([start, pos]);
                start = -1;
            }
            afterBlank = false;
        } else {
            const blank = /^[ \t]*$/.test(line);
            const indented = !blank && /^( {4,}|\t)/.test(line);
            if (start < 0) {
                if (indented && afterBlank) {
                    start = pos;
                }
            } else if (!indented && !blank) {
                ranges.push([start, pos]);
                start = -1;
            }
            afterBlank = blank;
        }
        if (newline === -1) {
            break;
        }
        pos = newline + 1;
    }
    if (start >= 0) {
        ranges.push([start, text.length]);
    }
    return ranges;
}

export function codeRanges(text: string): [number, number][] {
    const ranges: [number, number][] = [];
    for (const m of text.matchAll(FENCE)) {
        const start = m.index + m[1].length;
        ranges.push([start, m.index + m[0].length]);
    }
    ranges.push(...indentedCode(text, ranges));
    const inside = (pos: number) => ranges.some(([a, b]) => pos >= a && pos < b);
    for (const m of text.matchAll(INLINE_CODE)) {
        if (!inside(m.index)) {
            ranges.push([m.index, m.index + m[0].length]);
        }
    }
    return ranges.sort((a, b) => a[0] - b[0]);
}

function toNode(kind: Kind, m: RegExpMatchArray): MarkupNode {
    const attrs = readAttrs(m[1]);
    const from = m.index!;
    const node: MarkupNode = {
        kind,
        from,
        to: from + m[0].length,
        raw: m[0],
        text: m[2],
        author: attrs.author ?? null,
        date: attrs.date ?? null,
    };
    if (kind === 'substitution') {
        node.oldText = m[2];
        node.text = m[3];
    }
    if (kind === 'comment') {
        const legacy = m[2].match(LEGACY_AUTHOR);
        if (legacy) {
            node.author = node.author ?? legacy[1];
            node.text = m[2].slice(legacy[0].length);
        }
    }
    return node;
}

export function parse(text: string): Parsed {
    const code = codeRanges(text);
    const inCode = (pos: number) => code.some(([a, b]) => pos >= a && pos < b);

    const found: MarkupNode[] = [];
    for (const [kind, re] of PATTERNS) {
        for (const m of text.matchAll(re)) {
            found.push(toNode(kind, m));
        }
    }
    found.sort((a, b) => a.from - b.from);

    const nodes: MarkupNode[] = [];
    let end = -1;
    for (const node of found) {
        if (node.from < end || inCode(node.from) || inCode(node.to - 1)) {
            continue;
        }
        nodes.push(node);
        end = node.to;
    }

    const threads: Thread[] = [];
    let current: Thread | null = null;
    let last = -1;
    for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        if (node.kind !== 'comment') {
            continue;
        }
        if (current && last >= 0 && /^[ \t]*$/.test(text.slice(nodes[last].to, node.from))) {
            current.replyIndexes.push(i);
            current.to = node.to;
            last = i;
            continue;
        }
        const prev = nodes[i - 1];
        const anchored = prev !== undefined && prev.to === node.from && prev.kind !== 'comment' && prev.kind !== 'aitext';
        current = {
            rootIndex: i,
            replyIndexes: [],
            anchorIndex: anchored ? i - 1 : null,
            from: anchored ? prev.from : node.from,
            to: node.to,
        };
        threads.push(current);
        last = i;
    }
    return { text, nodes, threads };
}
