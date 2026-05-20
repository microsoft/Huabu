# AI half-baked output

This fixture mimics the kind of imperfect markdown a streaming agent might produce.

价格 $5 是普通文本里的美元符号,不应该被当成行内公式。

中英文混排 mix-and-match 段落,验证 CJK boundary 处理。

A dangling list with a missing line break:

- item one
- item two without trailing newline
- item three then immediately a paragraph

This paragraph follows the list without a blank line, which some parsers handle differently.

An unclosed fenced block follows; the closing fence is intentionally missing:

```ts
function loadData(): Promise<void> {
  return fetch('/api/data').then((r) => r.json());
}
```
