import * as vscode from 'vscode';
import { MarkupNode, Parsed, parse } from '../markup/parse';

// Where a VS Code thread comes from in the parse result. Pending threads (not yet written) have no source.
export type Source = { kind: 'thread'; index: number } | { kind: 'suggestion'; nodeIndex: number };

interface Entry {
    key: string;
    range: [number, number];
    source: Source;
    label: string;
    contextValue: string;
    comments: MarkupNode[];
}

const SUGGESTIONS = new Set(['addition', 'deletion', 'substitution']);

function short(text: string): string {
    const line = text.replace(/\s+/g, ' ').trim();
    return line.length > 40 ? line.slice(0, 39) + '…' : line;
}

function suggestionLabel(node: MarkupNode): string {
    switch (node.kind) {
        case 'addition': return `Added: ${short(node.text)}`;
        case 'deletion': return `Deleted: ${short(node.text)}`;
        default: return `Replaced: ${short(node.oldText!)} with ${short(node.text)}`;
    }
}

function entries(parsed: Parsed): Entry[] {
    const result: Entry[] = [];
    const anchored = new Set<number>();
    parsed.threads.forEach((thread, index) => {
        const anchor = thread.anchorIndex === null ? null : parsed.nodes[thread.anchorIndex];
        const isSuggestion = anchor !== null && SUGGESTIONS.has(anchor.kind);
        if (thread.anchorIndex !== null) {
            anchored.add(thread.anchorIndex);
        }
        result.push({
            key: parsed.text.slice(thread.from, thread.to),
            range: [thread.from, thread.to],
            source: isSuggestion ? { kind: 'suggestion', nodeIndex: thread.anchorIndex! } : { kind: 'thread', index },
            label: isSuggestion ? suggestionLabel(anchor) : anchor ? short(anchor.text) : '',
            contextValue: isSuggestion ? 'suggestionThread' : 'comment',
            comments: [thread.rootIndex, ...thread.replyIndexes].map(i => parsed.nodes[i]),
        });
    });
    parsed.nodes.forEach((node, nodeIndex) => {
        if (SUGGESTIONS.has(node.kind) && !anchored.has(nodeIndex)) {
            result.push({
                key: node.raw,
                range: [node.from, node.to],
                source: { kind: 'suggestion', nodeIndex },
                label: suggestionLabel(node),
                contextValue: 'suggestion',
                // A thread with no comments is not listed in the Comments panel, so describe the suggestion.
                comments: [{ ...node, text: suggestionLabel(node) }],
            });
        }
    });
    return result;
}

function toComment(node: MarkupNode): vscode.Comment {
    return {
        body: new vscode.MarkdownString(node.text),
        mode: vscode.CommentMode.Preview,
        author: { name: node.author ?? 'unknown' },
        label: node.date ?? undefined,
    };
}

export class ThreadManager implements vscode.Disposable {
    readonly controller = vscode.comments.createCommentController('criticmarkReview', 'CriticMark');
    private readonly docs = new Map<string, { parsed: Parsed; threads: Map<string, vscode.CommentThread[]> }>();
    private readonly sources = new WeakMap<vscode.CommentThread, Source>();

    constructor() {
        this.controller.commentingRangeProvider = {
            provideCommentingRanges: (document: vscode.TextDocument) =>
                document.languageId === 'markdown' ? [new vscode.Range(0, 0, document.lineCount, 0)] : [],
        };
    }

    refresh(document: vscode.TextDocument): Parsed {
        const parsed = parse(document.getText());
        const old = this.docs.get(document.uri.toString())?.threads ?? new Map<string, vscode.CommentThread[]>();
        const threads = new Map<string, vscode.CommentThread[]>();
        for (const entry of entries(parsed)) {
            const range = new vscode.Range(document.positionAt(entry.range[0]), document.positionAt(entry.range[1]));
            // Reuse a thread with the same text so its open reply box and expanded state survive.
            let thread = old.get(entry.key)?.shift();
            if (thread) {
                thread.range = range;
            } else {
                thread = this.controller.createCommentThread(document.uri, range, entry.comments.map(toComment));
                thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
                thread.label = entry.label;
                thread.contextValue = entry.contextValue;
            }
            this.sources.set(thread, entry.source);
            threads.set(entry.key, [...(threads.get(entry.key) ?? []), thread]);
        }
        for (const leftover of old.values()) {
            leftover.forEach(t => t.dispose());
        }
        this.docs.set(document.uri.toString(), { parsed, threads });
        return parsed;
    }

    forget(uri: vscode.Uri): void {
        this.docs.get(uri.toString())?.threads.forEach(list => list.forEach(t => t.dispose()));
        this.docs.delete(uri.toString());
    }

    parsed(uri: vscode.Uri): Parsed | undefined {
        return this.docs.get(uri.toString())?.parsed;
    }

    sourceOf(thread: vscode.CommentThread): Source | undefined {
        return this.sources.get(thread);
    }

    dispose(): void {
        for (const uri of [...this.docs.keys()]) {
            this.forget(vscode.Uri.parse(uri));
        }
        this.controller.dispose();
    }
}
