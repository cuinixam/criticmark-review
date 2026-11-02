import { MarkupNode, Parsed } from './parse';

export interface CardComment {
    nodeIndex: number;
    author: string | null;
    date: string | null;
    text: string;
}

// One entry in the review panel: a comment thread, a suggestion, or a suggestion with its thread.
export interface Card {
    // Stays the same through replies, resolve ticks and text moving before it, so the panel keeps typed text and open cards.
    // Built from the highlighted or suggested markup, or the first comment's text when nothing is highlighted, plus an occurrence number.
    id: string;
    // The card's full text in the file, for checking that the file still holds what the panel showed.
    raw: string;
    from: number;
    to: number;
    anchor: string;
    thread: number | null;
    suggestion: number | null;
    resolved: boolean;
    // The text a suggestion removes and adds, null for the side it does not have; null when the card is not a suggestion.
    change: { old: string | null; new: string | null } | null;
    comments: CardComment[];
}

const SUGGESTIONS = new Set(['addition', 'deletion', 'substitution']);

export function short(text: string): string {
    const line = text.replace(/\s+/g, ' ').trim();
    return line.length > 40 ? line.slice(0, 39) + '…' : line;
}

function change(node: MarkupNode): Card['change'] {
    switch (node.kind) {
        case 'addition': return { old: null, new: node.text };
        case 'deletion': return { old: node.text, new: null };
        default: return { old: node.oldText!, new: node.text };
    }
}

function suggestionLabel(node: MarkupNode): string {
    switch (node.kind) {
        case 'addition': return `Added: ${short(node.text)}`;
        case 'deletion': return `Deleted: ${short(node.text)}`;
        default: return `Replaced: ${short(node.oldText!)} with ${short(node.text)}`;
    }
}

export function cards(parsed: Parsed): Card[] {
    const result: (Omit<Card, 'id' | 'raw'> & { key: string })[] = [];
    const anchored = new Set<number>();
    parsed.threads.forEach((thread, index) => {
        const anchor = thread.anchorIndex === null ? null : parsed.nodes[thread.anchorIndex];
        const isSuggestion = anchor !== null && SUGGESTIONS.has(anchor.kind);
        if (thread.anchorIndex !== null) {
            anchored.add(thread.anchorIndex);
        }
        result.push({
            key: anchor === null ? parsed.nodes[thread.rootIndex].text : anchor.raw,
            from: thread.from,
            to: thread.to,
            anchor: anchor === null ? '' : isSuggestion ? suggestionLabel(anchor) : short(anchor.text),
            thread: index,
            suggestion: isSuggestion ? thread.anchorIndex : null,
            resolved: parsed.nodes[thread.rootIndex].status === 'resolved',
            change: isSuggestion ? change(anchor) : null,
            comments: [thread.rootIndex, ...thread.replyIndexes].map(i => {
                const node = parsed.nodes[i];
                return { nodeIndex: i, author: node.author, date: node.date, text: node.text };
            }),
        });
    });
    parsed.nodes.forEach((node, nodeIndex) => {
        if (SUGGESTIONS.has(node.kind) && !anchored.has(nodeIndex)) {
            result.push({
                key: node.raw,
                from: node.from, to: node.to, anchor: suggestionLabel(node), thread: null, suggestion: nodeIndex, resolved: false, change: change(node),
                comments: [],
            });
        }
    });
    result.sort((a, b) => a.from - b.from);
    const seen = new Map<string, number>();
    return result.map(({ key, ...card }) => {
        const n = seen.get(key) ?? 0;
        seen.set(key, n + 1);
        return { id: `${n}:${key}`, raw: parsed.text.slice(card.from, card.to), ...card };
    });
}
