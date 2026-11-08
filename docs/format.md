# CriticMarkup review format

This page is for AI agents and anyone who edits review markup without the extension. It describes the exact syntax the extension reads and writes. The Obsidian Track Changes plugin uses the same syntax, so a file works in both editors.

The review of a markdown file lives in the file itself. A file that is not markdown keeps its review in a sidecar file, see [Sidecar files](#sidecar-files). There is no database.

## Elements

```text
{>>comment<<}            a comment
{==text==}               highlighted text, usually followed by a comment
{++text++}               suggested insertion
{--text--}               suggested deletion
{~~old~>new~~}           suggested replacement
{=+text+=}               text written by an AI (shown underlined, not a suggestion)
```

The content of an element may span several lines.

## Author and date

Any element may carry attributes right after the opening brace:

```text
{author="Claude" date="2026-11-02">>I agree.<<}
```

- An attribute is `name="value"`. Several attributes are separated by spaces.
- A value may not contain `"`, `{`, `}` or a line break.
- `author` and `date` are the ones the extension shows. The date is `YYYY-MM-DD`.
- `status="resolved"` on the first comment of a thread marks the thread as resolved. Other attributes are kept as they are.
- A comment that starts with a short name and a colon (`{>>Claude: I agree.<<}`) uses that name as the author when there is no author attribute. The prefix is never shown as part of the text, so do not start a comment with a word and a colon (`Note: …`).

## Threads

A comment starts a thread. Comments that follow it with only spaces or tabs in between are replies in the same thread:

```text
{==the sentence==}{author="Max" date="2026-11-02">>Is this right?<<}{author="Claude" date="2026-11-02">>Yes, see the test.<<}
```

A line break between two comments starts a new thread.

A comment directly after a highlight or a suggestion, with nothing in between, belongs to that highlight or suggestion.

## Resolved threads

A thread is resolved when its first comment has `status="resolved"`:

```text
{==the sentence==}{author="Max" date="2026-11-02" status="resolved">>Is this right?<<}{author="Claude" date="2026-11-02">>Yes.<<}
```

Only the person reviewing marks a thread as resolved or reopens it. Do not reply to a resolved thread, and do not add or remove `status="resolved"`. To list the open threads, skip every thread whose first comment has that attribute.

## How to reply

1. Find the last comment of the thread.
2. Insert your comment directly after its `<<}`, on the same line, with your own author name and today's date.
3. Change nothing else.

Never put `<<}` inside a comment: it would end the comment early. Never put a line break between the comments of one thread.

## How to accept or reject a suggestion by hand

- `{++text++}`: accept keeps `text`, reject removes it.
- `{--text--}`: accept removes `text`, reject keeps it.
- `{~~old~>new~~}`: accept keeps `new`, reject keeps `old`.

Remove the markup and any comment thread attached to the suggestion. The extension does the same when you click Accept or Reject.

## What is ignored

Markup inside code is plain text: fenced code blocks (lines starting with three backticks or three tildes), indented code blocks (lines indented by four spaces or a tab after a blank line), and inline code. That is why the examples on this page are not threads.

An element that starts inside another element is ignored.

## Sidecar files

Inline markup would break the syntax of a code file, so the review of `foo.c` lives next to it in `foo.c.review`. When you read a file that is not markdown, check for its `.review` file. Reply in that file and do not put markup into the source.

The file is a list of entries separated by blank lines:

```text
{line="42"==static int x;==}{author="Max" date="2026-11-08">>Why static?<<}{author="Claude" date="2026-11-08">>Only used in this file.<<}

{line="57"==if (x > 3) {
    reset();
}==}{author="Max" date="2026-11-08" status="resolved">>Is 3 the right limit?<<}

{line="80"~~return 0;~>return ERR_TIMEOUT;~~}{author="Claude" date="2026-11-08">>The caller expects an error here.<<}

{line="95"--debug_dump();--}

{author="Max" date="2026-11-08">>General comment about the whole file.<<}
```

The elements, attributes, threads, replies and resolved state are the ones described above, with these differences:

- The quoted text in a highlight, a deletion or the old part of a replacement is the anchor: the exact text of the source. It may span lines. To remove a whole line, include its line break in the quote.
- `line="N"` is required on every anchor and is the first line of the quote in the source. It tells repeated text apart and goes stale when the code moves.
- `before` and `after` are optional. Each is the first 8 hex digits of the SHA-1 of the nearest non-blank line before or after the quote, without its indentation. The extension writes them, and they find the right copy of repeated text after the code moved. You may leave them out.
- A comment with `line` and no anchor sits on that blank line: `{line="40" before="e5f6a1b2" after="0a7bc3d4" author="Max" date="2026-11-08">>Text<<}`. A comment with neither applies to the whole file.
- Do not write a bare `{++text++}`, because it has nothing in the source to attach to. To add code, write a replacement of the neighbouring line.
- `{=+text+=}` is not used.
- Nothing counts as code: markup-like text inside backticks or fences is read as it is in a normal element.
- A quote cannot hold the closing marker of its own element (`==}`, `--}`, `~~}`) or `~>`. When the code contains one, quote less of it.
- Add new entries at the end of the file.
- To accept or reject by hand, change the source if accepting, then remove the entry and its blank line. When the last entry is gone, delete the file.

## Checking that no markup is left

```bash
grep -nE '\{(>>|\+\+|--|~~|==|=\+)|[a-z]+="[^"]*"(>>|\+\+|--|~~|==|=\+)' file.md
```
