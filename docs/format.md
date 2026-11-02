# CriticMarkup review format

This page is for AI agents and anyone who edits review markup without the extension. It describes the exact syntax the extension reads and writes. The Obsidian Track Changes plugin uses the same syntax, so a file works in both editors.

The review lives in the markdown file itself. There is no sidecar file and no database.

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

## Checking that no markup is left

```bash
grep -nE '\{(>>|\+\+|--|~~|==|=\+)|[a-z]+="[^"]*"(>>|\+\+|--|~~|==|=\+)' file.md
```
