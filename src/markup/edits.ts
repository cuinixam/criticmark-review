import { MarkupNode, Parsed, Thread, codeRanges } from './parse';

// `expected` is the text the edit replaces; callers refuse the edit when the document no longer has it.
export interface TextEdit {
    from: number;
    to: number;
    insert: string;
    expected: string;
}

export function validateBody(body: string): string | null {
    return body.includes('<<}') ? 'Replies cannot contain the CriticMarkup comment closing marker <<}.' : null;
}

export function commentMarkup(body: string, author: string, date: string): string {
    const error = validateBody(body);
    if (error) {
        throw new Error(error);
    }
    const name = author.replace(/[\x00-\x1f\x7f\u2028\u2029]/g, '').replace(/["{}]/g, '').trim();
    const meta = name ? `author="${name}" date="${date}"` : `date="${date}"`;
    return `{${meta}>>${body}<<}`;
}

const BLOCK_START = /^ {0,3}(#{1,6}[ \t]|[-*+][ \t]|\d+[.)][ \t]|>|```|~~~|\|)/;
const SINGLE_LINE_BLOCK = /^ {0,3}(#{1,6}[ \t]|\|)/;

// Same refusals as the Obsidian plugin, so a new mark never breaks an existing one.
export function checkSelection(parsed: Parsed, from: number, to: number): string | null {
    const hits = (a: number, b: number) => from === to ? a < from && from < b : a < to && from < b;
    if (parsed.nodes.some(n => hits(n.from, n.to))) {
        return 'Cannot create a mark overlapping an existing CriticMarkup mark.';
    }
    if (codeRanges(parsed.text).some(([a, b]) => hits(a, b))) {
        return 'Cannot create a mark inside a code block or inline code.';
    }
    const selected = parsed.text.slice(from, to);
    const lines = selected.split('\n');
    const lineStart = parsed.text.lastIndexOf('\n', from - 1) + 1;
    const firstLine = parsed.text.slice(lineStart, parsed.text.indexOf('\n', from));
    if (/\n[ \t]*\n/.test(selected) || lines.slice(1).some(l => BLOCK_START.test(l))
        || (lines.length > 1 && SINGLE_LINE_BLOCK.test(firstLine))) {
        return 'Selection spans more than one block; select within a single paragraph.';
    }
    if (selected.includes('==}')) {
        return 'Selection contains "==}", which would break the mark.';
    }
    return null;
}

// `expected` is the text the user selected when the thread was opened; it defaults to the text at the offsets now.
export function addComment(
    parsed: Parsed, from: number, to: number, body: string, author: string, date: string, expected?: string,
): TextEdit {
    const error = checkSelection(parsed, from, to);
    if (error) {
        throw new Error(error);
    }
    const comment = commentMarkup(body, author, date);
    const selected = parsed.text.slice(from, to);
    const insert = from === to ? comment : `{==${selected}==}${comment}`;
    return { from, to, insert, expected: expected ?? selected };
}

export function commentOnNode(parsed: Parsed, nodeIndex: number, body: string, author: string, date: string): TextEdit {
    const node = parsed.nodes[nodeIndex];
    return { from: node.from, to: node.to, insert: node.raw + commentMarkup(body, author, date), expected: node.raw };
}

export function reply(parsed: Parsed, thread: Thread, body: string, author: string, date: string): TextEdit {
    const last = parsed.nodes[thread.replyIndexes.at(-1) ?? thread.rootIndex];
    return { from: last.from, to: last.to, insert: last.raw + commentMarkup(body, author, date), expected: last.raw };
}

export function editComment(parsed: Parsed, nodeIndex: number, body: string): TextEdit {
    const error = validateBody(body);
    if (error) {
        throw new Error(error);
    }
    const node = parsed.nodes[nodeIndex];
    const inner = node.raw.slice(node.meta.length + 3, -3);
    // Keep a legacy `Name:` prefix, which is how that comment names its author.
    const prefix = inner.slice(0, inner.length - node.text.length);
    return { from: node.from, to: node.to, insert: `{${node.meta}>>${prefix}${body}<<}`, expected: node.raw };
}

function withStatus(node: MarkupNode, resolved: boolean): string {
    let meta = node.meta.replace(/(^|[ \t]+)status="[^"]*"/gi, '').trim();
    if (resolved) {
        meta = meta ? `${meta} status="resolved"` : 'status="resolved"';
    }
    return `{${meta}${node.raw.slice(node.meta.length + 1)}`;
}

// The state lives on the first comment, which replies never move.
export function setResolved(parsed: Parsed, thread: Thread, resolved: boolean): TextEdit {
    const root = parsed.nodes[thread.rootIndex];
    return { from: root.from, to: root.to, insert: withStatus(root, resolved), expected: root.raw };
}

// Deleting the last comment deletes the thread. Deleting the first one moves the resolved state to the next.
export function deleteComment(parsed: Parsed, thread: Thread, nodeIndex: number): TextEdit {
    const ids = [thread.rootIndex, ...thread.replyIndexes];
    const position = ids.indexOf(nodeIndex);
    if (position < 0) {
        throw new Error('The comment is not in this thread.');
    }
    if (ids.length === 1) {
        return deleteThread(parsed, thread);
    }
    const node = parsed.nodes[nodeIndex];
    let from: number, to: number, insert: string;
    if (position === 0) {
        const next = parsed.nodes[ids[1]];
        [from, to] = [node.from, next.to];
        insert = node.status === 'resolved' ? withStatus(next, true) : next.raw;
        // A sidecar comment on a blank line holds its place itself, so the next comment takes it over.
        const place = node.meta.match(/(?:line|before|after)="[^"]*"/g);
        if (place) {
            insert = `{${place.join(' ')} ${insert.slice(1)}`;
        }
    } else {
        [from, to, insert] = [parsed.nodes[ids[position - 1]].to, node.to, ''];
    }
    return { from, to, insert, expected: parsed.text.slice(from, to) };
}

export function deleteThread(parsed: Parsed, thread: Thread): TextEdit {
    const anchor = thread.anchorIndex === null ? null : parsed.nodes[thread.anchorIndex];
    const insert = anchor === null ? '' : anchor.kind === 'highlight' ? anchor.text : anchor.raw;
    return { from: thread.from, to: thread.to, insert, expected: parsed.text.slice(thread.from, thread.to) };
}

export function resolveSuggestion(parsed: Parsed, nodeIndex: number, accept: boolean): TextEdit {
    const node = parsed.nodes[nodeIndex];
    let insert: string;
    switch (node.kind) {
        case 'addition':
            insert = accept ? node.text : '';
            break;
        case 'deletion':
            insert = accept ? '' : node.text;
            break;
        case 'substitution':
            insert = accept ? node.text : node.oldText!;
            break;
        default:
            throw new Error(`not a suggestion: ${node.kind}`);
    }
    // The decision closes the discussion, so a thread anchored to the suggestion goes with it.
    const thread = parsed.threads.find(t => t.anchorIndex === nodeIndex);
    const to = thread ? thread.to : node.to;
    return { from: node.from, to, insert, expected: parsed.text.slice(node.from, to) };
}

export function isCurrent(text: string, edit: TextEdit): boolean {
    return text.slice(edit.from, edit.to) === edit.expected;
}
