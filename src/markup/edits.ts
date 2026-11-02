import { Parsed, Thread, codeRanges } from './parse';

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
