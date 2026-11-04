// Review panel webview. Builds the cards with textContent only: comment text comes from the file and is untrusted.
(function () {
    const vscode = acquireVsCodeApi();
    const root = document.getElementById('root');
    const saved = vscode.getState() || {};
    // Cards whose open state differs from the default: open threads start expanded, resolved ones collapsed.
    const toggled = new Set(saved.toggled || []);
    let state = { file: null, cards: [], draft: null, hideResolved: false };
    // Comment being edited: { id, position }.
    let editing = null;
    // Comment whose "…" menu is open: { id, position }, with position -1 for the card's own menu.
    let menu = null;
    // Text typed in every box, by file and box, so it survives re-renders and switching files.
    const typed = new Map();
    // The box whose text was last sent, cleared once the extension confirms the write.
    let sent = null;
    const SUBMIT_KEY = /Mac/.test(navigator.platform) ? '⌘↵' : 'Ctrl+Enter';

    const ICONS = {
        chevronRight: 'M6 4l4 4-4 4-.7-.7L8.6 8 5.3 4.7z',
        chevronDown: 'M4 6l4 4 4-4-.7-.7L8 8.6 4.7 5.3z',
        more: 'M2.3 8a1.2 1.2 0 1 0 2.4 0 1.2 1.2 0 0 0-2.4 0zm4.5 0a1.2 1.2 0 1 0 2.4 0 1.2 1.2 0 0 0-2.4 0zm4.5 0a1.2 1.2 0 1 0 2.4 0 1.2 1.2 0 0 0-2.4 0z',
        circleCheck: 'M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zm0 1a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11zm2.6 3.2L7 9.3 5.4 7.7l-.7.7L7 10.7l4.3-4.3z',
        circleCheckFilled: 'M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm-1 9.7L4.7 8.4l.7-.7L7 9.3l3.6-3.6.7.7z',
    };

    function remember() {
        vscode.setState({ toggled: [...toggled] });
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

    function icon(name) {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 16 16');
        svg.setAttribute('aria-hidden', 'true');
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', ICONS[name]);
        path.setAttribute('fill', 'currentColor');
        path.setAttribute('fill-rule', 'evenodd');
        svg.append(path);
        return svg;
    }

    function button(label, className, onClick, title) {
        const b = el('button', className, label);
        if (title) {
            b.title = title;
            b.setAttribute('aria-label', title);
        }
        b.addEventListener('click', event => {
            event.stopPropagation();
            onClick();
        });
        return b;
    }

    function iconButton(name, className, onClick, title) {
        const b = button(undefined, 'icon ' + className, onClick, title);
        b.append(icon(name));
        return b;
    }

    function isOpen(card) {
        return card.resolved ? toggled.has(card.id) : !toggled.has(card.id);
    }

    function setOpen(card, open) {
        if (open === card.resolved) {
            toggled.add(card.id);
        } else {
            toggled.delete(card.id);
        }
    }

    function typedKey(key) {
        return `${state.file}|${key}`;
    }

    // Same author, same colour.
    function avatar(name) {
        let hash = 0;
        for (const ch of name) {
            hash = (hash * 31 + ch.codePointAt(0)) % 360;
        }
        const box = el('span', 'avatar', (Array.from(name)[0] || '?').toUpperCase());
        box.style.background = `hsl(${hash}, 45%, 42%)`;
        return box;
    }

    // A text box with its buttons. Cmd/Ctrl+Enter submits, Escape cancels. A compact box shows its buttons only while in use.
    function editor(key, value, placeholder, submitLabel, onSubmit, onCancel, compact) {
        const box = el('div', 'editor' + (compact ? ' compact' : ''));
        const area = el('textarea');
        area.dataset.key = key;
        area.value = typed.has(typedKey(key)) ? typed.get(typedKey(key)) : value;
        area.placeholder = placeholder;
        area.rows = compact ? 1 : 3;
        const update = () => box.classList.toggle('active', document.activeElement === area || area.value !== '');
        area.addEventListener('input', () => {
            typed.set(typedKey(key), area.value);
            update();
        });
        area.addEventListener('focus', update);
        area.addEventListener('blur', update);
        const submit = () => {
            if (area.value.trim()) {
                sent = typedKey(key);
                onSubmit(area.value);
            }
        };
        const cancel = () => {
            typed.delete(typedKey(key));
            if (onCancel) {
                onCancel();
            } else {
                area.value = '';
                area.blur();
                update();
                vscode.postMessage({ type: 'focusEditor' });
            }
        };
        area.addEventListener('keydown', event => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                submit();
            } else if (event.key === 'Escape') {
                cancel();
            }
        });
        const row = el('div', 'row');
        row.append(el('span', 'hint', `${SUBMIT_KEY} · Esc`));
        row.append(button('Cancel', 'btn', cancel));
        row.append(button(submitLabel, 'btn primary', submit));
        box.append(area, row);
        update();
        return box;
    }

    function commentView(card, comment, position) {
        const box = el('div', 'comment');
        box.append(avatar(comment.author || '?'));
        const body = el('div', 'cbody');
        const who = el('div', 'who');
        who.append(el('b', '', comment.author || 'unknown'));
        if (comment.date) {
            who.append(el('span', 'date', comment.date));
        }
        const menuOpen = menu && menu.id === card.id && menu.position === position;
        who.append(iconButton('more', 'more' + (menuOpen ? ' shown' : ''), () => {
            menu = menuOpen ? null : { id: card.id, position };
            draw();
        }, 'More actions'));
        body.append(who);
        if (menuOpen) {
            const list = el('div', 'menu');
            list.append(button('Edit', '', () => {
                menu = null;
                editing = { id: card.id, position };
                draw();
            }));
            list.append(button('Delete comment', 'danger', () => {
                menu = null;
                draw();
                vscode.postMessage({ type: 'deleteComment', id: card.id, position });
            }));
            body.append(list);
        }
        const isEditing = editing && editing.id === card.id && editing.position === position;
        if (isEditing) {
            body.append(editor(`edit:${card.id}:${position}`, comment.text, '', 'Save',
                text => vscode.postMessage({ type: 'edit', id: card.id, position, body: text }),
                () => {
                    editing = null;
                    draw();
                }));
        } else {
            body.append(el('div', 'text', comment.text));
        }
        box.append(body);
        return box;
    }

    function diffView(card) {
        const box = el('div', 'diff');
        const label = el('div', 'label');
        label.append(el('span', '', 'Suggested change'));
        const actions = el('span', 'actions');
        actions.append(button('Reject', 'btn', () => vscode.postMessage({ type: 'reject', id: card.id })));
        actions.append(button('Accept', 'btn primary', () => vscode.postMessage({ type: 'accept', id: card.id })));
        label.append(actions);
        box.append(label);
        if (card.change.old !== null) {
            box.append(el('div', 'del', card.change.old));
        }
        if (card.change.new !== null) {
            box.append(el('div', 'add', card.change.new));
        }
        return box;
    }

    function header(title, open, pill, onToggle) {
        const head = el('div', 'head');
        head.tabIndex = 0;
        head.setAttribute('role', 'button');
        head.setAttribute('aria-expanded', String(open));
        const chevron = el('span', 'chevron');
        chevron.append(icon(open ? 'chevronDown' : 'chevronRight'));
        head.append(chevron, el('span', 'quote', title));
        if (pill) {
            head.append(el('span', 'pill ' + pill.toLowerCase(), pill));
        }
        if (onToggle) {
            head.addEventListener('click', onToggle);
            head.addEventListener('keydown', event => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onToggle();
                }
            });
        }
        return head;
    }

    function cardView(card) {
        const open = isOpen(card);
        const box = el('div', 'card' + (card.resolved ? ' resolved' : ''));
        box.dataset.id = card.id;
        const pill = card.resolved ? 'Resolved' : card.suggestion !== null ? 'Suggestion' : '';
        const head = header(card.anchor || 'Comment', open, pill, () => {
            setOpen(card, !open);
            remember();
            draw();
            vscode.postMessage({ type: 'reveal', id: card.id });
        });
        if (card.thread !== null) {
            const menuOpen = menu && menu.id === card.id && menu.position === -1;
            head.append(iconButton('more', 'more' + (menuOpen ? ' shown' : ''), () => {
                menu = menuOpen ? null : { id: card.id, position: -1 };
                draw();
            }, 'More actions'));
            if (menuOpen) {
                const list = el('div', 'menu');
                list.addEventListener('click', event => event.stopPropagation());
                list.append(button('Delete thread', 'danger', () => {
                    menu = null;
                    draw();
                    vscode.postMessage({ type: 'delete', id: card.id });
                }));
                head.append(list);
            }
            head.append(iconButton(card.resolved ? 'circleCheckFilled' : 'circleCheck', 'resolve' + (card.resolved ? ' done' : ''),
                () => vscode.postMessage({ type: 'resolve', id: card.id, resolved: !card.resolved }),
                card.resolved ? 'Reopen thread' : 'Resolve thread'));
        }
        box.append(head);

        if (!open) {
            if (card.comments.length) {
                const replies = card.comments.length - 1;
                box.append(el('div', 'summary',
                    card.comments[0].text + (replies ? ` · ${replies} ${replies === 1 ? 'reply' : 'replies'}` : '')));
            }
            return box;
        }
        if (card.change) {
            box.append(diffView(card));
        }
        card.comments.forEach((comment, position) => box.append(commentView(card, comment, position)));
        const reply = el('div', 'reply');
        const empty = card.comments.length === 0;
        reply.append(editor(`reply:${card.id}`, '', empty ? 'Comment…' : 'Reply…', empty ? 'Comment' : 'Reply',
            text => vscode.postMessage({ type: 'reply', id: card.id, body: text }), null, true));
        box.append(reply);
        return box;
    }

    function draftView(draft) {
        const box = el('div', 'card draft');
        box.dataset.id = '';
        box.append(header(draft.anchor || 'New comment', true, 'New'));
        const reply = el('div', 'reply');
        reply.append(editor('draft', '', 'Comment…', 'Comment',
            text => vscode.postMessage({ type: 'submitDraft', body: text }),
            () => vscode.postMessage({ type: 'cancelDraft' })));
        box.append(reply);
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
        const visible = state.hideResolved ? state.cards.filter(c => !c.resolved) : state.cards;
        const items = visible.map(card => ({ from: card.from, node: cardView(card) }));
        if (state.draft) {
            items.push({ from: state.draft.from, node: draftView(state.draft) });
            items.sort((a, b) => a.from - b.from);
        }
        if (!state.cards.length && !state.draft) {
            root.append(el('p', 'empty', 'No threads in this file. Select text, right-click and choose Add Comment.'));
        }
        items.forEach(item => root.append(item.node));
        const hidden = state.cards.length - visible.length;
        if (hidden) {
            const line = button(`${hidden} resolved ${hidden === 1 ? 'thread' : 'threads'} hidden`, 'hidden-line',
                () => vscode.postMessage({ type: 'setHideResolved', hide: false }), 'Show resolved threads');
            line.prepend(icon('chevronRight'));
            root.append(line);
        }

        const again = focused && [...root.querySelectorAll('textarea')].find(area => area.dataset.key === focused.key);
        if (again) {
            again.focus();
            again.setSelectionRange(focused.start, focused.end);
        }
    }

    function cardNode(id) {
        return [...root.querySelectorAll('.card')].find(node => node.dataset.id === (id || ''));
    }

    document.addEventListener('click', () => {
        if (menu) {
            menu = null;
            draw();
        }
    });

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
        } else if (message.type === 'command') {
            state.cards.forEach(card => setOpen(card, message.name === 'expandAll'));
            remember();
            draw();
        } else if (message.type === 'select' || message.type === 'focus') {
            const card = state.cards.find(c => c.id === message.id);
            if (card && !isOpen(card)) {
                setOpen(card, true);
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
