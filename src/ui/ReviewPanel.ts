import * as vscode from 'vscode';
import { Card } from '../markup/cards';

export const VIEW_ID = 'criticmarkReview.threads';

// What the panel shows. A draft is a comment being written for a selection that is not in the file yet.
export interface PanelState {
    file: string | null;
    cards: Card[];
    draft: { from: number; anchor: string } | null;
}

export type PanelMessage =
    | { type: 'ready' }
    | { type: 'reveal'; id: string }
    | { type: 'reply'; id: string; body: string }
    | { type: 'edit'; id: string; position: number; body: string }
    | { type: 'delete'; id: string }
    | { type: 'accept'; id: string }
    | { type: 'reject'; id: string }
    | { type: 'resolve'; id: string; resolved: boolean }
    | { type: 'submitDraft'; body: string }
    | { type: 'cancelDraft' };

// The side panel. It only draws state and forwards clicks; extension.ts turns them into file edits.
export class ReviewPanel implements vscode.WebviewViewProvider {
    private view: vscode.WebviewView | undefined;
    private ready = false;
    private state: PanelState = { file: null, cards: [], draft: null };
    private pendingFocus: string | null = null;

    constructor(private readonly extensionUri: vscode.Uri, private readonly onMessage: (message: PanelMessage) => void) {}

    resolveWebviewView(view: vscode.WebviewView): void {
        this.view = view;
        this.ready = false;
        const media = vscode.Uri.joinPath(this.extensionUri, 'media');
        view.webview.options = { enableScripts: true, localResourceRoots: [media] };
        const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
        const script = view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'panel.js'));
        const style = view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'panel.css'));
        view.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${style}" rel="stylesheet">
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
        view.webview.onDidReceiveMessage((message: PanelMessage) => {
            if (message.type === 'ready') {
                this.ready = true;
                this.post();
                return;
            }
            this.onMessage(message);
        });
        view.onDidDispose(() => {
            this.view = undefined;
            this.ready = false;
        });
    }

    render(state: PanelState): void {
        this.state = state;
        this.post();
    }

    // Opens the panel and puts the keyboard focus into the reply box of a card, or of the draft when id is null.
    async focus(id: string | null): Promise<void> {
        this.pendingFocus = id ?? '';
        await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
        this.post();
    }

    // Tells the panel whether its last submit reached the file, so it clears the text box only then.
    result(ok: boolean): void {
        if (this.ready) {
            this.view?.webview.postMessage({ type: 'result', ok });
        }
    }

    // Expands and scrolls to a card without taking the focus from the editor.
    select(id: string): void {
        if (this.ready) {
            this.view?.webview.postMessage({ type: 'select', id });
        }
    }

    private post(): void {
        if (!this.view || !this.ready) {
            return;
        }
        this.view.webview.postMessage({ type: 'render', state: this.state });
        if (this.pendingFocus !== null) {
            this.view.webview.postMessage({ type: 'focus', id: this.pendingFocus || null });
            this.pendingFocus = null;
        }
    }
}
