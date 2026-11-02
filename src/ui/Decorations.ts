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
        backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
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
        for (const node of parsed.nodes) {
            // Offsets are counted from the end, because an attribute value may contain marker characters.
            const innerTo = node.to - CLOSE;
            const innerFrom = innerTo - node.text.length;
            switch (node.kind) {
                case 'addition': inserted.push(range(innerFrom, innerTo)); break;
                case 'deletion': removed.push(range(innerFrom, innerTo)); break;
                case 'highlight': highlight.push(range(innerFrom, innerTo)); break;
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
        }
        editor.setDecorations(this.inserted, inserted);
        editor.setDecorations(this.removed, removed);
        editor.setDecorations(this.highlight, highlight);
        editor.setDecorations(this.aitext, aitext);
    }

    dispose(): void {
        [this.inserted, this.removed, this.highlight, this.aitext].forEach(d => d.dispose());
    }
}
