# AGENTS.md

## 记忆系统（docs/memory/）

本根目录下 `docs/memory/` 为记忆库，结构与流程规范见 `docs/memory/_README.md`，索引导航见 `docs/memory/_INDEX.md`。

- **归档**：用户说出触发词（"总结归档"或同义：归档、总结并归档、记录一下、存档）时，严格按 `_README.md` 第四节流程执行：提取关键词 → 判断系统日期 → 写记忆文件（YYYY/MM/DD/<模块名>.md）→ 更新当日 core.md → 更新 YYYY.md → 更新词汇分片 _INDEX-<域>.md。
- **检索**：回答历史问题时，必须主动走 `_README.md` 第五节检索链路（_INDEX.md → _INDEX-<域>.md → 当日 core.md → 记忆文件），不能只凭当前对话上下文回答。
- **约束**：禁止编造、追加不覆盖、日期用系统当前时间、中文命名、不存敏感信息，详见 `_README.md` 第六节。
- 本文件与 `docs/memory/_README.md` 同步维护：规范有更新时，两处一并修改。
