import * as vscode from 'vscode';
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

    dispose(): void {
        [this.inserted, this.removed, this.highlight, this.aitext, this.resolved].forEach(d => d.dispose());
    }
}
