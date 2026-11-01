---
title: "What to do when billion-context compresses frequently?"
title_zh: "billion-context频繁压缩该怎么办?"
date: 2026-11-01
excerpt: "Frequent compression is not automatically a bug: three steps to tell normal behavior from problems, and when to file an issue."
excerpt_zh: "压缩频繁不等于出故障：三步分辨正常行为与异常，以及什么时候该提 issue。"
---

A few cases to tell apart:

1. Unlike traditional compression software, billion-context only does incremental compression, never whole-context (global) compression. So seeing it compress more often than a classic tool is normal.
2. In some cases it will still compress frequently: if a compression happens every three or five calls, the model is most likely reading huge amounts of logs, code, etc., which trips the incremental threshold. If you have many such scenarios, raising `nudge` (default 50k) to 80k–100k improves things noticeably.
3. If none of the above applies, it's probably a bug — report it at [github.com/ranxianglei/billion-context/issues](https://github.com/ranxianglei/billion-context/issues), with your log attached if possible. Usually resolved within the week.
