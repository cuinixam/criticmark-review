import * as assert from 'assert';
import { parse } from '../../markup/parse';
import { findQuote, placeCards } from '../../markup/sidecar';

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
        assert.deepStrictEqual(findQuote('x\ny\nx\n', 'x', 3), { from: 4, to: 5, count: 2, onLine: true });
    });

    test('matches a LF quote in a CRLF source', () => {
        assert.deepStrictEqual(findQuote('a\r\nb', 'a\nb', 1), { from: 0, to: 4, count: 1, onLine: true });
    });

    test('treats regular expression characters as text', () => {
        assert.deepStrictEqual(findQuote('f(a.b)', '(a.b)', 1), { from: 1, to: 6, count: 1, onLine: true });
    });

    test('returns null for an empty quote', () => {
        assert.strictEqual(findQuote('abc', '', null), null);
    });

    test('returns null when the quote is gone', () => {
        assert.strictEqual(findQuote('abc', 'z', 1), null);
    });

    test('works without a line hint', () => {
        assert.deepStrictEqual(findQuote('x\nx', 'x', null), { from: 0, to: 1, count: 2, onLine: false });
    });
});

suite('placeCards', () => {
    test('moves a card to the source and keeps its sidecar range in entry', () => {
        const text = '{line="2"==b==}{author="a" date="d">>x<<}';
        const [card] = placeCards(parse(text, true), 'a\nb\n');
        assert.deepStrictEqual([card.from, card.to, card.entry], [2, 3, { from: 0, to: text.length }]);
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
