---
title: "billion-context频繁压缩该怎么办?"
date: 2026-11-01
excerpt: "压缩频繁不等于出故障：三步分辨正常行为与异常，以及什么时候该提 issue。"
excerpt_zh: "压缩频繁不等于出故障：三步分辨正常行为与异常，以及什么时候该提 issue。"
---

区分几种情况：

1. 区别于传统压缩软件，billion-context 只做增量压缩不做全局压缩。所以看到的压缩比传统更频繁很正常。
2. 有一些情况下，还是会频繁压缩：如果三五个调用就压缩一次，大概率模型在疯狂读入日志、代码等，触发了增量阈值。如果有大量类似场景，建议调大 `nudge`（默认 5w），调大到 8w 到 10w 可以明显改善。
3. 如果以上都不是，那么可能是遇到了 bug，请到 [github.com/ranxianglei/billion-context/issues](https://github.com/ranxianglei/billion-context/issues) 报告，最好带上日志，一般会周内解决。
