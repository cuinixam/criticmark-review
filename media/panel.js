// Review panel webview. Builds the cards with textContent only: comment text comes from the file and is untrusted.
(function () {
    const vscode = acquireVsCodeApi();
    const root = document.getElementById('root');
    const saved = vscode.getState() || {};
    const expanded = new Set(saved.expanded || []);
    let state = { file: null, cards: [], draft: null };
    // Comment being edited: { id, position }.
    let editing = null;
    // Text typed in every box, by file and box, so it survives re-renders and switching files.
    const typed = new Map();
    // The box whose text was last sent, cleared once the extension confirms the write.
    let sent = null;

    function typedKey(key) {
        return `${state.file}|${key}`;
    }

    function remember() {
        vscode.setState({ expanded: [...expanded] });
    }

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) {
            node.className = className;
        }
        if (text !== undefined) {
            node.textContent = text;
        }
        return node;
    }

    function button(label, onClick, title) {
        const b = el('button', '', label);
        if (title) {
            b.title = title;
        }
        b.addEventListener('click', event => {
            event.stopPropagation();
            onClick();
        });
        return b;
    }

    // A text box with its buttons. Cmd/Ctrl+Enter submits, Escape cancels.
    function editor(key, value, placeholder, submitLabel, onSubmit, onCancel) {
        const box = el('div', 'editor');
        const area = el('textarea');
        area.dataset.key = key;
        area.value = typed.has(typedKey(key)) ? typed.get(typedKey(key)) : value;
        area.placeholder = placeholder;
        area.rows = 3;
        area.addEventListener('input', () => typed.set(typedKey(key), area.value));
        const submit = () => {
            if (area.value.trim()) {
                sent = typedKey(key);
                onSubmit(area.value);
            }
        };
        area.addEventListener('keydown', event => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                submit();
            } else if (event.key === 'Escape' && onCancel) {
                onCancel();
            }
        });
        const row = el('div', 'buttons');
        row.append(button(submitLabel, submit));
        if (onCancel) {
            row.append(button('Cancel', onCancel));
        }
        box.append(area, row);
        return box;
    }

    function commentView(card, comment, position) {
        const box = el('div', 'comment');
        const meta = el('div', 'meta');
        meta.append(el('span', 'author', comment.author || 'unknown'));
        if (comment.date) {
            meta.append(el('span', 'date', comment.date));
        }
        const isEditing = editing && editing.id === card.id && editing.position === position;
        if (!isEditing) {
            meta.append(button('Edit', () => {
                editing = { id: card.id, position };
                draw();
            }, 'Edit this comment'));
        }
        box.append(meta);
        if (isEditing) {
            const key = `edit:${card.id}:${position}`;
            box.append(editor(key, comment.text, '', 'Save', body => {
                vscode.postMessage({ type: 'edit', id: card.id, position, body });
            }, () => {
                editing = null;
                typed.delete(typedKey(key));
                draw();
            }));
        } else {
            box.append(el('div', 'text', comment.text));
        }
        return box;
    }

    function cardView(card) {
        const open = expanded.has(card.id);
        const box = el('div', 'card' + (card.resolved ? ' resolved' : '') + (open ? ' open' : ''));
        box.dataset.id = card.id;

        const head = el('div', 'head');
        if (card.thread !== null) {
            const check = el('input');
            check.type = 'checkbox';
            check.checked = card.resolved;
            check.title = card.resolved ? 'Resolved. Untick to reopen.' : 'Mark as resolved';
            check.addEventListener('click', event => event.stopPropagation());
            check.addEventListener('change', () => vscode.postMessage({ type: 'resolve', id: card.id, resolved: check.checked }));
            head.append(check);
        }
        head.append(el('span', 'twisty', open ? '▾' : '▸'));
        const title = el('div', 'title');
        if (card.anchor) {
            title.append(el('span', card.suggestion !== null ? 'anchor suggestion' : 'anchor', card.anchor));
        }
        if (!open && card.comments.length) {
            const first = card.comments[0];
            const replies = card.comments.length - 1;
            title.append(el('span', 'summary', first.text + (replies ? ` (${replies} ${replies === 1 ? 'reply' : 'replies'})` : '')));
        }
        head.append(title);
        head.addEventListener('click', () => {
            if (open) {
                expanded.delete(card.id);
            } else {
                expanded.add(card.id);
            }
            remember();
            draw();
            vscode.postMessage({ type: 'reveal', id: card.id });
        });
        box.append(head);

        if (open) {
            const body = el('div', 'body');
            card.comments.forEach((comment, position) => body.append(commentView(card, comment, position)));
            const empty = card.comments.length === 0;
            body.append(editor(`reply:${card.id}`, '', empty ? 'Comment…' : 'Reply…', empty ? 'Comment' : 'Reply',
                text => vscode.postMessage({ type: 'reply', id: card.id, body: text })));
            const actions = el('div', 'buttons actions');
            if (card.suggestion !== null) {
                actions.append(button('Accept', () => vscode.postMessage({ type: 'accept', id: card.id }), 'Accept the suggestion'));
                actions.append(button('Reject', () => vscode.postMessage({ type: 'reject', id: card.id }), 'Reject the suggestion'));
            }
            if (card.thread !== null) {
                actions.append(button('Delete', () => vscode.postMessage({ type: 'delete', id: card.id }), 'Delete the thread'));
            }
            body.append(actions);
            box.append(body);
        }
        return box;
    }

    function draftView(draft) {
        const box = el('div', 'card open draft');
        box.dataset.id = '';
        const head = el('div', 'head');
        const title = el('div', 'title');
        title.append(el('span', 'summary', 'New comment'));
        if (draft.anchor) {
            title.append(el('span', 'anchor', draft.anchor));
        }
        head.append(title);
        box.append(head);
        const body = el('div', 'body');
        body.append(editor('draft', '', 'Comment…', 'Comment',
            text => vscode.postMessage({ type: 'submitDraft', body: text }),
            () => {
                typed.delete(typedKey('draft'));
                vscode.postMessage({ type: 'cancelDraft' });
            }));
        box.append(body);
        return box;
    }

    // Rebuilds the list but keeps the focused box and its caret, so a file change does not disturb what is being written.
    function draw() {
        const active = document.activeElement;
        const focused = active && active.tagName === 'TEXTAREA'
            ? { key: active.dataset.key, start: active.selectionStart, end: active.selectionEnd }
            : null;

        root.replaceChildren();
        if (!state.file) {
            root.append(el('p', 'empty', 'Open a markdown file to see its review threads.'));
            return;
        }
        if (editing && !state.cards.some(c => c.id === editing.id)) {
            editing = null;
        }
        const items = state.cards.map(card => ({ from: card.from, node: cardView(card) }));
        if (state.draft) {
            items.push({ from: state.draft.from, node: draftView(state.draft) });
            items.sort((a, b) => a.from - b.from);
        }
        if (!items.length) {
            root.append(el('p', 'empty', 'No threads in this file. Select text, right-click and choose Add Comment.'));
        }
        items.forEach(item => root.append(item.node));

        const again = focused && [...root.querySelectorAll('textarea')].find(area => area.dataset.key === focused.key);
        if (again) {
            again.focus();
            again.setSelectionRange(focused.start, focused.end);
        }
    }

    function cardNode(id) {
        return [...root.querySelectorAll('.card')].find(node => node.dataset.id === (id || ''));
    }

    window.addEventListener('message', event => {
        const message = event.data;
        if (message.type === 'result') {
            if (message.ok && sent) {
                typed.delete(sent);
                if (sent.startsWith(`${state.file}|edit:`)) {
                    editing = null;
                }
                draw();
            }
            sent = null;
        } else if (message.type === 'render') {
            state = message.state;
            draw();
        } else if (message.type === 'select' || message.type === 'focus') {
            if (message.id && !expanded.has(message.id)) {
                expanded.add(message.id);
                remember();
                draw();
            }
            const node = cardNode(message.id);
            if (node) {
                node.scrollIntoView({ block: 'nearest' });
                if (message.type === 'focus') {
                    const areas = node.querySelectorAll('textarea');
                    if (areas.length) {
                        areas[areas.length - 1].focus();
                    }
                }
            }
        }
    });

    vscode.postMessage({ type: 'ready' });
})();
