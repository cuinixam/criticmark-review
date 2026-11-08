import * as assert from 'assert';
import { Card } from '../../markup/cards';
import { TextEdit, deleteComment } from '../../markup/edits';
import { parse } from '../../markup/parse';
import { acceptEdit, addEntry, cardAt, contextAt, entryOf, findBlank, findQuote, lineHash, placeCards, quoteAt, removeEntry, sidecarEnabled } from '../../markup/sidecar';

function apply(text: string, edit: TextEdit): string {
    return text.slice(0, edit.from) + edit.insert + text.slice(edit.to);
}

suite('sidecar edits and selection', () => {
    test('sidecarEnabled', () => {
        assert.strictEqual(sidecarEnabled('/a/foo.c', ['*']), true);
        assert.strictEqual(sidecarEnabled('/a/foo.c', []), false);
        assert.strictEqual(sidecarEnabled('/a/foo.PY', ['.py']), true);
        assert.strictEqual(sidecarEnabled('/a/foo.py', ['py']), true);
        assert.strictEqual(sidecarEnabled('/a/foo.c', ['.py']), false);
        assert.strictEqual(sidecarEnabled('/a/foo.c.review', ['*']), false);
    });

    test('sidecarEnabled treats a malformed setting as no extensions', () => {
        assert.strictEqual(sidecarEnabled('/a/foo.c', '.c' as unknown as string[]), false);
        assert.strictEqual(sidecarEnabled('/a/foo.c', [1, '.c'] as unknown as string[]), true);
    });

    test('entryOf finds an entry again in text that changed', () => {
        assert.deepStrictEqual(entryOf('new\n\nA\n', 'A'), { from: 5, to: 6 });
    });

    test('entryOf refuses an entry that is gone', () => {
        assert.throws(() => entryOf('new\n', 'A'));
    });

    test('quoteAt keeps a selection, trims the current line, and gives an empty quote on a blank line', () => {
        assert.deepStrictEqual(quoteAt('  ab\n', 2, 3), { from: 2, to: 3, quote: 'a' });
        assert.deepStrictEqual(quoteAt('  ab\n', 3, 3), { from: 2, to: 4, quote: 'ab' });
        assert.deepStrictEqual(quoteAt('a\n\nb', 2, 2), { from: 2, to: 2, quote: '' });
    });

    test('quoteAt leaves a CRLF line ending out of the quote', () => {
        assert.deepStrictEqual(quoteAt('ab\r\ncd', 1, 1), { from: 0, to: 2, quote: 'ab' });
    });

    test('cardAt: a cursor takes the smallest card, a different selection takes none', () => {
        const big = { from: 0, to: 10 } as Card;
        const small = { from: 2, to: 5 } as Card;
        assert.strictEqual(cardAt([big, small], 3, 3), small);
        assert.strictEqual(cardAt([big, small], 2, 5), small);
        assert.strictEqual(cardAt([big, small], 1, 3), undefined);
    });

    test('addEntry appends after a blank line and writes line', () => {
        const edit = addEntry('old', 'x', { line: 7, before: null, after: null }, 'c', 'a', 'd');
        assert.strictEqual(edit.insert, '\n\n{line="7"==x==}{author="a" date="d">>c<<}\n');
    });

    test('addEntry writes a quote with LF line endings', () => {
        assert.strictEqual(addEntry('', 'x\r\ny', { line: 1, before: null, after: null }, 'c', 'a', 'd').insert, '{line="1"==x\ny==}{author="a" date="d">>c<<}\n');
    });

    test('addEntry with no quote writes a whole-file comment', () => {
        assert.strictEqual(addEntry('', '', null, 'c', 'a', 'd').insert, '{author="a" date="d">>c<<}\n');
    });

    test('addEntry refuses a quote holding ==}', () => {
        assert.throws(() => addEntry('', 'a==}', { line: 1, before: null, after: null }, 'c', 'a', 'd'));
    });

    test('removeEntry also removes the blank line that separates it', () => {
        const text = 'A\n\nB\n\nC\n';
        assert.strictEqual(apply(text, removeEntry(text, { from: 3, to: 4 })), 'A\n\nC\n');
    });

    test('removeEntry of the last entry leaves one line ending', () => {
        const text = 'A\n\nB\n';
        assert.strictEqual(apply(text, removeEntry(text, { from: 3, to: 4 })), 'A\n');
    });

    test('removeEntry of the only entry leaves nothing', () => {
        const text = 'A\n';
        assert.strictEqual(apply(text, removeEntry(text, { from: 0, to: 1 })), '');
    });

    test('acceptEdit replaces the anchor and writes the line endings of the source', () => {
        const parsed = parse('{line="1"~~a\nb~>c\nd~~}', true);
        const source = 'a\r\nb';
        assert.strictEqual(acceptEdit(parsed, placeCards(parsed, source)[0], source).insert, 'c\r\nd');
    });

    test('acceptEdit on a deletion inserts nothing', () => {
        const parsed = parse('{line="1"--a--}', true);
        assert.strictEqual(acceptEdit(parsed, placeCards(parsed, 'a')[0], 'a').insert, '');
    });

    test('acceptEdit refuses a replacement that holds the marker', () => {
        const parsed = parse('{line="1"~~v = "~> 3.0"~>v = "~> 4.0"~~}', true);
        const source = 'v = "~> 3.0"';
        assert.throws(() => acceptEdit(parsed, placeCards(parsed, source)[0], source));
    });

    test('acceptEdit refuses orphaned and ambiguous cards', () => {
        const repeated = parse('{line="2"~~x~>y~~}', true);
        assert.throws(() => acceptEdit(repeated, placeCards(repeated, 'x\nq\nx')[0], 'x\nq\nx'));
        const gone = parse('{line="1"~~x~>y~~}', true);
        assert.throws(() => acceptEdit(gone, placeCards(gone, 'q')[0], 'q'));
    });
});

// Line 2 and line 6 hold the same text; only their neighbours tell them apart.
const REPEATED = 'first();\n*/\nalpha();\n\nbeta();\n*/\ngamma();\n';
const SECOND = { line: 6, before: lineHash('beta();'), after: lineHash('gamma();') };

suite('neighbours', () => {
    test('lineHash ignores indentation and line endings', () => {
        assert.strictEqual(lineHash('  a\r'), lineHash('a'));
    });

    test('contextAt hashes the nearest non-blank line on each side', () => {
        const from = REPEATED.lastIndexOf('*/');
        assert.deepStrictEqual(contextAt(REPEATED, from, from + 2), SECOND);
    });

    test('contextAt on a blank line uses the lines around it', () => {
        const from = REPEATED.indexOf('\n\n') + 1;
        assert.deepStrictEqual(contextAt(REPEATED, from, from), { line: 4, before: lineHash('alpha();'), after: lineHash('beta();') });
    });

    test('contextAt at the edges of the file has no neighbour', () => {
        assert.deepStrictEqual(contextAt('only', 0, 4), { line: 1, before: null, after: null });
    });

    test('neighbours beat the line number after the code moved', () => {
        const moved = 'x();\ny();\nz();\n' + REPEATED;
        const match = findQuote(moved, '*/', 6, SECOND);
        assert.deepStrictEqual([match!.from, match!.confirmed], [moved.lastIndexOf('*/'), true]);
    });

    test('with no matching neighbours nothing is confirmed', () => {
        const match = findQuote(REPEATED, '*/', 2, { before: 'none', after: 'none' });
        assert.deepStrictEqual([match!.count, match!.confirmed], [2, false]);
    });

    test('findBlank finds the blank line between its neighbours after lines moved', () => {
        const source = 'a\n\nb\n\nc\n';
        const context = { before: lineHash('b'), after: lineHash('c') };
        assert.strictEqual(findBlank(source, 1, context), 5);
    });

    test('findBlank returns null when the neighbours are gone', () => {
        assert.strictEqual(findBlank('a\n\nb\n', 2, { before: 'none', after: 'none' }), null);
    });

    test('findBlank without neighbours needs the line itself to be blank', () => {
        assert.strictEqual(findBlank('a\n\nb\n', 2, { before: null, after: null }), 2);
        assert.strictEqual(findBlank('a\n\nb\n', 1, { before: null, after: null }), null);
    });

    test('placeCards puts a blank-line comment on its line', () => {
        const before = lineHash('alpha();');
        const after = lineHash('beta();');
        const text = `{line="4" before="${before}" after="${after}" author="a" date="d">>c<<}`;
        const [card] = placeCards(parse(text, true), REPEATED);
        const blank = REPEATED.indexOf('\n\n') + 1;
        assert.deepStrictEqual([card.from, card.to, card.orphaned], [blank, blank, undefined]);
    });

    test('placeCards orphans a blank-line comment whose neighbours are gone', () => {
        const [card] = placeCards(parse('{line="1" before="x" after="y" author="a" date="d">>c<<}', true), 'a\n\nb\n');
        assert.strictEqual(card.orphaned, true);
    });

    test('a copy on the stored line with other neighbours is ambiguous', () => {
        const text = `{line="2" before="${SECOND.before}" after="${SECOND.after}"~~*/~>x~~}`;
        assert.strictEqual(placeCards(parse(text, true), 'a\n*/\nb\n\nc\n*/\nd\n')[0].ambiguous, true);
    });

    test('repeated code with matching neighbours is not ambiguous', () => {
        const text = `{line="2" before="${SECOND.before}" after="${SECOND.after}"~~*/~>x~~}`;
        assert.strictEqual(placeCards(parse(text, true), REPEATED)[0].ambiguous, false);
    });

    test('addEntry writes the neighbours on the anchor', () => {
        const edit = addEntry('', 'x', { line: 7, before: 'aa', after: 'bb' }, 'c', 'a', 'd');
        assert.strictEqual(edit.insert, '{line="7" before="aa" after="bb"==x==}{author="a" date="d">>c<<}\n');
    });

    test('addEntry on a blank line writes the place on the comment', () => {
        const edit = addEntry('', '', { line: 7, before: 'aa', after: 'bb' }, 'c', 'a', 'd');
        assert.strictEqual(edit.insert, '{line="7" before="aa" after="bb" author="a" date="d">>c<<}\n');
    });

    test('deleting the first comment of a blank-line thread keeps its place', () => {
        const text = '{line="3" before="a" after="b" author="x" date="d">>one<<}{author="y" date="d">>two<<}';
        const parsed = parse(text, true);
        assert.strictEqual(apply(text, deleteComment(parsed, parsed.threads[0], 0)), '{line="3" before="a" after="b" author="y" date="d">>two<<}');
    });

    test('a cursor on a blank-line card opens it, but not a whole-file card', () => {
        const blank = { from: 5, to: 5 } as Card;
        const whole = { from: 0, to: 0 } as Card;
        assert.strictEqual(cardAt([whole, blank], 5, 5), blank);
        assert.strictEqual(cardAt([whole, blank], 0, 0), undefined);
    });
});

suite('sidecar parsing', () => {
    test('a quote holding markup-like text does not swallow the next entry', () => {
        const text = '{line="1"=={--i;==}{author="a" date="d">>x<<}\n\n{line="9"--dump();--}';
        assert.deepStrictEqual(parse(text, true).nodes.map(n => n.kind), ['highlight', 'comment', 'deletion']);
    });

    test('sidecar parsing ignores backticks and fences', () => {
        const backticks = '{line="1"==`a`==}{author="a" date="d">>x<<}';
        assert.strictEqual(parse(backticks, true).threads.length, 1);
        const fence = '{line="1"==```\ncode\n```==}{author="a" date="d">>x<<}';
        assert.strictEqual(parse(fence, true).threads.length, 1);
    });

    test('line is read from the anchor', () => {
        assert.strictEqual(parse('{line="42"==x==}', true).nodes[0].line, 42);
    });

    test('a sidecar parse leaves inline parsing unchanged', () => {
        parse('{line="1"==a==}{author="a" date="d">>x<<}', true);
        assert.strictEqual(parse('{==a==}').nodes.length, 1);
    });
});

suite('findQuote', () => {
    test('takes the nearest match to line', () => {
        assert.deepStrictEqual(findQuote('x\ny\nx\n', 'x', 3), { from: 4, to: 5, count: 2, onLine: true, confirmed: false });
    });

    test('matches a LF quote in a CRLF source', () => {
        assert.deepStrictEqual(findQuote('a\r\nb', 'a\nb', 1), { from: 0, to: 4, count: 1, onLine: true, confirmed: false });
    });

    test('treats regular expression characters as text', () => {
        assert.deepStrictEqual(findQuote('f(a.b)', '(a.b)', 1), { from: 1, to: 6, count: 1, onLine: true, confirmed: false });
    });

    test('returns null for an empty quote', () => {
        assert.strictEqual(findQuote('abc', '', null), null);
    });

    test('returns null when the quote is gone', () => {
        assert.strictEqual(findQuote('abc', 'z', 1), null);
    });

    test('works without a line hint', () => {
        assert.deepStrictEqual(findQuote('x\nx', 'x', null), { from: 0, to: 1, count: 2, onLine: false, confirmed: false });
    });
});

suite('placeCards', () => {
    test('moves a card to the source and keeps its sidecar text in raw', () => {
        const text = '{line="2"==b==}{author="a" date="d">>x<<}';
        const [card] = placeCards(parse(text, true), 'a\nb\n');
        assert.deepStrictEqual([card.from, card.to, card.raw], [2, 3, text]);
    });

    test('marks a missing quote and a bare addition as orphaned', () => {
        const text = '{line="1"==gone==}{author="a" date="d">>x<<}\n\n{line="1"++new++}';
        const placed = placeCards(parse(text, true), 'a\n');
        assert.deepStrictEqual(placed.map(c => c.orphaned), [true, true]);
        assert.ok(placed[0].anchor.startsWith('Orphaned: '));
    });

    test('marks repeated code with no match on line as ambiguous', () => {
        const [card] = placeCards(parse('{line="2"==x==}{author="a" date="d">>c<<}', true), 'x\ny\nx\n');
        assert.strictEqual(card.ambiguous, true);
    });

    test('an anchor without line uses the first match and throws nothing', () => {
        const [card] = placeCards(parse('{==x==}{author="a" date="d">>c<<}', true), 'q\nx\n');
        assert.deepStrictEqual([card.from, card.to], [2, 3]);
    });

    test('a comment with no anchor is a whole-file card at offset 0', () => {
        const [card] = placeCards(parse('{author="a" date="d">>c<<}', true), 'a\n');
        assert.deepStrictEqual([card.from, card.to, card.orphaned], [0, 0, undefined]);
    });

    test('orders cards by position in the source', () => {
        const text = '{line="2"==b==}{author="a" date="d">>x<<}\n\n{line="1"==a==}{author="a" date="d">>y<<}';
        assert.deepStrictEqual(placeCards(parse(text, true), 'a\nb\n').map(c => c.comments[0].text), ['y', 'x']);
    });
});
