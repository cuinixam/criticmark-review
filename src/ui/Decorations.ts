import * as vscode from 'vscode';
import { Card } from '../markup/cards';
import { Parsed } from '../markup/parse';

// Closing markers (`++}`, `--}`, `==}`, `+=}`, `~~}`) are three characters long.
const CLOSE = 3;

export class Decorations implements vscode.Disposable {
    private readonly inserted = vscode.window.createTextEditorDecorationType({
        backgroundColor: new vscode.ThemeColor('diffEditor.insertedTextBackground'),
    });
    private readonly removed = vscode.window.createTextEditorDecorationType({
        backgroundColor: new vscode.ThemeColor('diffEditor.removedTextBackground'),
        textDecoration: 'line-through',
    });
    private readonly highlight = vscode.window.createTextEditorDecorationType({
        backgroundColor: new vscode.ThemeColor('criticmarkReview.highlightBackground'),
    });
    // An underline, not a background: a green background already means added text.
    private readonly resolved = vscode.window.createTextEditorDecorationType({
        borderStyle: 'none none solid none',
        borderWidth: '0 0 2px 0',
        borderColor: new vscode.ThemeColor('gitDecoration.addedResourceForeground'),
    });
    private readonly aitext = vscode.window.createTextEditorDecorationType({
        textDecoration: 'underline dotted',
    });

    private readonly selected: vscode.TextEditorDecorationType;

    constructor(extensionUri: vscode.Uri) {
        this.selected = vscode.window.createTextEditorDecorationType({
            light: { gutterIconPath: vscode.Uri.joinPath(extensionUri, 'media', 'mark-light.svg'), gutterIconSize: 'contain' },
            dark: { gutterIconPath: vscode.Uri.joinPath(extensionUri, 'media', 'mark-dark.svg'), gutterIconSize: 'contain' },
        });
    }

    // Shows which line the selected card belongs to. An image cannot use a theme colour, so it has a light and a dark version.
    mark(editor: vscode.TextEditor, position: vscode.Position | undefined): void {
        editor.setDecorations(this.selected, position ? [new vscode.Range(position, position)] : []);
    }

    apply(editor: vscode.TextEditor, parsed: Parsed): void {
        const doc = editor.document;
        const range = (from: number, to: number) => new vscode.Range(doc.positionAt(from), doc.positionAt(to));
        const inserted: vscode.Range[] = [];
        const removed: vscode.Range[] = [];
        const highlight: vscode.Range[] = [];
        const aitext: vscode.DecorationOptions[] = [];
        const resolved: vscode.Range[] = [];
        // A resolved thread turns its highlight green, or the comments themselves when nothing is highlighted.
        const resolvedHighlights = new Set<number>();
        for (const thread of parsed.threads) {
            if (parsed.nodes[thread.rootIndex].status !== 'resolved') {
                continue;
            }
            if (thread.anchorIndex === null) {
                resolved.push(range(thread.from, thread.to));
            } else if (parsed.nodes[thread.anchorIndex].kind === 'highlight') {
                resolvedHighlights.add(thread.anchorIndex);
            }
        }
        parsed.nodes.forEach((node, index) => {
            // Offsets are counted from the end, because an attribute value may contain marker characters.
            const innerTo = node.to - CLOSE;
            const innerFrom = innerTo - node.text.length;
            switch (node.kind) {
                case 'addition': inserted.push(range(innerFrom, innerTo)); break;
                case 'deletion': removed.push(range(innerFrom, innerTo)); break;
                case 'highlight': (resolvedHighlights.has(index) ? resolved : highlight).push(range(innerFrom, innerTo)); break;
                case 'aitext':
                    aitext.push({ range: range(innerFrom, innerTo), hoverMessage: node.author ?? 'AI text' });
                    break;
                case 'substitution': {
                    inserted.push(range(innerFrom, innerTo));
                    const oldTo = innerFrom - 2;
                    removed.push(range(oldTo - node.oldText!.length, oldTo));
                    break;
                }
            }
        });
        editor.setDecorations(this.inserted, inserted);
        editor.setDecorations(this.removed, removed);
        editor.setDecorations(this.highlight, highlight);
        editor.setDecorations(this.aitext, aitext);
        editor.setDecorations(this.resolved, resolved);
    }

    // A sidecar's markup is not in this editor, so its cards say where to draw. The new text of a replacement can only be drawn.
    applyCards(editor: vscode.TextEditor, parsed: Parsed, cards: Card[]): void {
        const doc = editor.document;
        const highlight: vscode.Range[] = [];
        const resolved: vscode.Range[] = [];
        const removed: vscode.DecorationOptions[] = [];
        for (const card of cards.filter(c => c.from !== c.to)) {
            const range = new vscode.Range(doc.positionAt(card.from), doc.positionAt(card.to));
            if (card.suggestion === null) {
                (card.resolved ? resolved : highlight).push(range);
                continue;
            }
            const node = parsed.nodes[card.suggestion];
            if (node.kind !== 'substitution') {
                removed.push({ range });
                continue;
            }
            const lines = node.text.split(/\r?\n/);
            removed.push({
                range,
                renderOptions: {
                    after: {
                        contentText: lines.length > 1 ? `${lines[0]} …` : lines[0],
                        backgroundColor: new vscode.ThemeColor('diffEditor.insertedTextBackground'),
                        textDecoration: 'none',
                    },
                },
            });
        }
        editor.setDecorations(this.inserted, []);
        editor.setDecorations(this.removed, removed);
        editor.setDecorations(this.highlight, highlight);
        editor.setDecorations(this.aitext, []);
        editor.setDecorations(this.resolved, resolved);
    }

    dispose(): void {
        [this.inserted, this.removed, this.highlight, this.aitext, this.resolved, this.selected].forEach(d => d.dispose());
    }
}
