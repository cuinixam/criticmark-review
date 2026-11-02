import * as assert from 'assert';
import { parse } from '../../markup/parse';
import {
    TextEdit, addComment, checkSelection, commentMarkup, commentOnNode, deleteComment, deleteThread, editComment, isCurrent, reply,
    resolveSuggestion,
    setResolved, validateBody,
} from '../../markup/edits';

const DATE = '2026-11-02';

function apply(text: string, edit: TextEdit): string {
    return text.slice(0, edit.from) + edit.insert + text.slice(edit.to);
}

suite('edits', () => {
    test('commentMarkup writes author and date', () => {
        assert.strictEqual(commentMarkup('hi', 'Max', DATE), '{author="Max" date="2026-11-02">>hi<<}');
        assert.strictEqual(commentMarkup('hi', '', DATE), '{date="2026-11-02">>hi<<}');
    });

    test('commentMarkup cleans the author', () => {
        assert.strictEqual(commentMarkup('hi', 'Ma"x{}\n', DATE), '{author="Max" date="2026-11-02">>hi<<}');
    });

    test('validateBody refuses the closing marker', () => {
        assert.strictEqual(validateBody('a <<} b'), 'Replies cannot contain the CriticMarkup comment closing marker <<}.');
        assert.strictEqual(validateBody('fine'), null);
        assert.throws(() => commentMarkup('a <<} b', '', DATE));
    });

    test('addComment wraps a selection', () => {
        const text = 'hello world';
        const parsed = parse(text);
        assert.strictEqual(apply(text, addComment(parsed, 6, 11, 'c', '', DATE)), 'hello {==world==}{date="2026-11-02">>c<<}');
        assert.strictEqual(apply(text, addComment(parsed, 5, 5, 'c', '', DATE)), 'hello{date="2026-11-02">>c<<} world');
    });

    test('addComment is stale when the selected text moved', () => {
        const edit = addComment(parse('XXhello'), 0, 5, 'c', '', DATE, 'hello');
        assert.strictEqual(isCurrent('XXhello', edit), false);
    });

    const refused: [string, number, number, string][] = [
        ['see {++new++} text', 0, 8, 'Cannot create a mark overlapping an existing CriticMarkup mark.'],
        ['a {>>c<<} b', 4, 4, 'Cannot create a mark overlapping an existing CriticMarkup mark.'],
        ['see `code` here', 5, 7, 'Cannot create a mark inside a code block or inline code.'],
        ['one\n\ntwo', 0, 8, 'Selection spans more than one block; select within a single paragraph.'],
        ['one\n- two', 0, 9, 'Selection spans more than one block; select within a single paragraph.'],
        ['a ==} b', 0, 7, 'Selection contains "==}", which would break the mark.'],
    ];
    for (const [text, from, to, message] of refused) {
        test(`checkSelection refuses ${JSON.stringify(text.slice(from, to))}`, () => {
            const parsed = parse(text);
            assert.strictEqual(checkSelection(parsed, from, to), message);
            assert.throws(() => addComment(parsed, from, to, 'c', '', DATE), { message });
        });
    }

    test('checkSelection allows a plain selection and a point after a mark', () => {
        const parsed = parse('a {++x++} b');
        assert.strictEqual(checkSelection(parsed, 0, 1), null);
        assert.strictEqual(checkSelection(parsed, 9, 9), null);
    });

    test('commentOnNode attaches the first comment to a suggestion', () => {
        const text = 'a {++x++} b';
        const parsed = parse(text);
        const edit = commentOnNode(parsed, 0, 'why', '', DATE);
        assert.strictEqual(apply(text, edit), 'a {++x++}{date="2026-11-02">>why<<} b');
        assert.strictEqual(isCurrent('zz' + text, edit), false);
        assert.strictEqual(parse(apply(text, edit)).threads[0].anchorIndex, 0);
    });

    test('reply appends after the last comment', () => {
        const text = 'a {==x==}{>>c<<}{>>r<<} b';
        const parsed = parse(text);
        const result = apply(text, reply(parsed, parsed.threads[0], 'new', 'Claude', DATE));
        assert.strictEqual(result, 'a {==x==}{>>c<<}{>>r<<}{author="Claude" date="2026-11-02">>new<<} b');
        const again = parse(result);
        assert.strictEqual(again.threads.length, 1);
        assert.strictEqual(again.threads[0].replyIndexes.length, 2);
    });

    test('deleteThread unwraps the highlight', () => {
        const text = 'a {==x==}{>>c<<}{>>r<<} b';
        const parsed = parse(text);
        assert.strictEqual(apply(text, deleteThread(parsed, parsed.threads[0])), 'a x b');
    });

    test('deleteThread keeps an anchoring suggestion', () => {
        const text = 'a {++x++}{>>c<<} b';
        const parsed = parse(text);
        assert.strictEqual(apply(text, deleteThread(parsed, parsed.threads[0])), 'a {++x++} b');
    });

    const cases: [string, boolean, string][] = [
        ['a {++x++} b', true, 'a x b'],
        ['a {++x++} b', false, 'a  b'],
        ['a {--x--} b', true, 'a  b'],
        ['a {--x--} b', false, 'a x b'],
        ['a {~~x~>y~~} b', true, 'a y b'],
        ['a {~~x~>y~~} b', false, 'a x b'],
        ['a {++x++}{>>c<<}{>>r<<} b', true, 'a x b'],
        ['a {~~x~>y~~}{>>c<<} b', false, 'a x b'],
    ];
    for (const [text, accept, expected] of cases) {
        test(`resolveSuggestion ${accept ? 'accepts' : 'rejects'} ${text}`, () => {
            const parsed = parse(text);
            const index = parsed.nodes.findIndex(n => n.kind !== 'comment');
            assert.strictEqual(apply(text, resolveSuggestion(parsed, index, accept)), expected);
        });
    }

    test('editComment replaces only the text', () => {
        const text = 'a {==x==}{author="Max" date="2026-11-01">>old<<}{>>Claude: r<<} b';
        const parsed = parse(text);
        assert.strictEqual(apply(text, editComment(parsed, 1, 'new')), 'a {==x==}{author="Max" date="2026-11-01">>new<<}{>>Claude: r<<} b');
        assert.strictEqual(apply(text, editComment(parsed, 2, 'again')), 'a {==x==}{author="Max" date="2026-11-01">>old<<}{>>Claude: again<<} b');
        assert.throws(() => editComment(parsed, 1, 'a <<} b'));
    });

    const deleteCases: [string, number, string][] = [
        ['a {==x==}{>>c<<}{>>r<<} b', 2, 'a {==x==}{>>c<<} b'],
        ['a {==x==}{>>c<<}{>>r<<} b', 1, 'a {==x==}{>>r<<} b'],
        ['a {==x==}{author="M" status="resolved">>c<<} {>>r<<} b', 1, 'a {==x==}{status="resolved">>r<<} b'],
        ['a {==x==}{>>c<<} b', 1, 'a x b'],
        ['a {++x++}{>>c<<} b', 1, 'a {++x++} b'],
    ];
    for (const [text, nodeIndex, expected] of deleteCases) {
        test(`deleteComment ${nodeIndex} in ${text}`, () => {
            const parsed = parse(text);
            assert.strictEqual(apply(text, deleteComment(parsed, parsed.threads[0], nodeIndex)), expected);
        });
    }

    const resolveCases: [string, boolean, string][] = [
        ['{==x==}{author="Max" date="2026-11-01">>c<<}{>>r<<}', true, '{==x==}{author="Max" date="2026-11-01" status="resolved">>c<<}{>>r<<}'],
        ['{==x==}{>>c<<}', true, '{==x==}{status="resolved">>c<<}'],
        ['{==x==}{author="Max" status="resolved" date="2026-11-01">>c<<}', false, '{==x==}{author="Max" date="2026-11-01">>c<<}'],
        ['{==x==}{status="resolved">>c<<}', false, '{==x==}{>>c<<}'],
        ['{==x==}{status="resolved">>c<<}', true, '{==x==}{status="resolved">>c<<}'],
        ['{==x==}{Status="resolved">>c<<}', false, '{==x==}{>>c<<}'],
    ];
    for (const [text, resolved, expected] of resolveCases) {
        test(`setResolved ${resolved} on ${text}`, () => {
            const parsed = parse(text);
            const result = apply(text, setResolved(parsed, parsed.threads[0], resolved));
            assert.strictEqual(result, expected);
            assert.strictEqual(parse(result).nodes[1].status === 'resolved', resolved);
        });
    }

    test('isCurrent detects a changed document', () => {
        const text = 'a {==x==}{>>c<<} b';
        const parsed = parse(text);
        const edit = reply(parsed, parsed.threads[0], 'r', '', DATE);
        assert.strictEqual(isCurrent(text, edit), true);
        assert.strictEqual(isCurrent('zz' + text, edit), false);
    });
});
