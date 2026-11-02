import * as vscode from 'vscode';
import { TextEdit, addComment, commentOnNode, deleteThread, isCurrent, reply, resolveSuggestion, validateBody } from './markup/edits';
import { parse } from './markup/parse';
import { Decorations } from './ui/Decorations';
import { ThreadManager } from './ui/ThreadManager';

const DEBOUNCE_MS = 200;

function today(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function author(): string {
    return vscode.workspace.getConfiguration('criticmarkReview').get<string>('author', '');
}

function documentOf(uri: vscode.Uri): vscode.TextDocument | undefined {
    return vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
}

export function activate(context: vscode.ExtensionContext): void {
    const threads = new ThreadManager();
    const decorations = new Decorations();
    const timers = new Map<string, NodeJS.Timeout>();
    // Text selected when Add Comment opened a thread, so a later submit can tell whether the text moved.
    const selections = new WeakMap<vscode.CommentThread, string>();
    context.subscriptions.push(threads, decorations);

    const refresh = (document: vscode.TextDocument) => {
        if (document.languageId !== 'markdown') {
            return;
        }
        const parsed = threads.refresh(document);
        for (const editor of vscode.window.visibleTextEditors) {
            if (editor.document === document) {
                decorations.apply(editor, parsed);
            }
        }
    };

    const applyEdit = async (document: vscode.TextDocument, build: () => TextEdit): Promise<boolean> => {
        let edit: TextEdit;
        try {
            edit = build();
        } catch (e) {
            vscode.window.showErrorMessage((e as Error).message);
            return false;
        }
        if (!isCurrent(document.getText(), edit)) {
            vscode.window.showWarningMessage('The file changed since this thread was shown. Try again.');
            refresh(document);
            return false;
        }
        const workspaceEdit = new vscode.WorkspaceEdit();
        const range = new vscode.Range(document.positionAt(edit.from), document.positionAt(edit.to));
        workspaceEdit.replace(document.uri, range, edit.insert);
        const ok = await vscode.workspace.applyEdit(workspaceEdit);
        // Save right away: the agent reads the file on disk, and an unsaved buffer would not pick up its replies.
        if (ok && !document.isUntitled) {
            await document.save();
        }
        refresh(document);
        return ok;
    };

    const resolve = async (thread: vscode.CommentThread, accept: boolean) => {
        const document = documentOf(thread.uri);
        const parsed = document && threads.parsed(thread.uri);
        const source = threads.sourceOf(thread);
        if (document && parsed && source?.kind === 'suggestion') {
            await applyEdit(document, () => resolveSuggestion(parsed, source.nodeIndex, accept));
        }
    };

    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(refresh),
        vscode.workspace.onDidCloseTextDocument(d => threads.forget(d.uri)),
        vscode.workspace.onDidChangeTextDocument(e => {
            const key = e.document.uri.toString();
            clearTimeout(timers.get(key));
            timers.set(key, setTimeout(() => refresh(e.document), DEBOUNCE_MS));
        }),
        vscode.window.onDidChangeVisibleTextEditors(editors => {
            for (const editor of editors) {
                const parsed = threads.parsed(editor.document.uri);
                if (parsed) {
                    decorations.apply(editor, parsed);
                }
            }
        }),

        vscode.commands.registerCommand('criticmarkReview.addComment', () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                return;
            }
            const thread = threads.controller.createCommentThread(editor.document.uri, editor.selection, []);
            selections.set(thread, editor.document.getText(editor.selection));
            thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
        }),

        vscode.commands.registerCommand('criticmarkReview.reply', async (commentReply: vscode.CommentReply) => {
            const { thread, text: body } = commentReply;
            const error = validateBody(body);
            if (error) {
                vscode.window.showErrorMessage(error);
                return;
            }
            const document = documentOf(thread.uri);
            const parsed = document && threads.parsed(thread.uri);
            if (!document || !parsed) {
                return;
            }
            const source = threads.sourceOf(thread);
            if (!source) {
                // A new thread: write it, then the rebuild shows the real one.
                const start = document.offsetAt(thread.range?.start ?? new vscode.Position(0, 0));
                const end = document.offsetAt(thread.range?.end ?? new vscode.Position(0, 0));
                const selected = selections.get(thread);
                // A gutter thread has no remembered selection and may span whole lines: comment at its end, no highlight.
                const from = selected === undefined ? end : start;
                const build = () => addComment(parse(document.getText()), from, end, body, author(), today(), selected);
                if (await applyEdit(document, build)) {
                    thread.dispose();
                }
                return;
            }
            const target = source.kind === 'thread'
                ? parsed.threads[source.index]
                : parsed.threads.find(t => t.anchorIndex === source.nodeIndex);
            if (target) {
                await applyEdit(document, () => reply(parsed, target, body, author(), today()));
            } else if (source.kind === 'suggestion') {
                // First comment on a bare suggestion: append it right after the suggestion.
                await applyEdit(document, () => commentOnNode(parsed, source.nodeIndex, body, author(), today()));
            }
        }),

        vscode.commands.registerCommand('criticmarkReview.deleteThread', async (thread: vscode.CommentThread) => {
            const source = threads.sourceOf(thread);
            const document = documentOf(thread.uri);
            const parsed = document && threads.parsed(thread.uri);
            if (!source) {
                thread.dispose();
                return;
            }
            if (!document || !parsed) {
                return;
            }
            const target = source.kind === 'thread'
                ? parsed.threads[source.index]
                : parsed.threads.find(t => t.anchorIndex === source.nodeIndex);
            if (target) {
                await applyEdit(document, () => deleteThread(parsed, target));
            }
        }),

        vscode.commands.registerCommand('criticmarkReview.accept', (thread: vscode.CommentThread) => resolve(thread, true)),
        vscode.commands.registerCommand('criticmarkReview.reject', (thread: vscode.CommentThread) => resolve(thread, false)),
    );

    vscode.workspace.textDocuments.forEach(refresh);
}

export function deactivate(): void {}
