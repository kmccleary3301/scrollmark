# Scrollmark 简体中文说明

Scrollmark 是由 Kyle McCleary 维护的本地优先 X/Twitter 研究归档、搜索、媒体浏览与可移植 Bundle 工具。

它最初源自 [`prinsss/twitter-web-exporter`](https://github.com/prinsss/twitter-web-exporter) 的 MIT 许可 fork，但现在已经在采集、搜索、存储、界面、Bundle 导入/导出、诊断、性能与发布流程等方面完成了大规模重建。原项目版权与许可证声明会继续保留。

> 当前最完整、最新的项目说明以仓库根目录的 [`README.md`](../README.md) 为准。本文件用于给中文用户提供简洁入口，避免旧版 Twitter Web Exporter 文案继续误导使用者。

## 核心能力

| 模块          | 说明                                                                                                                    |
| ------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 本地采集      | 在浏览 X 网页版时，解析已加载到浏览器里的书签、推文、用户、喜欢、媒体、关注/粉丝关系、转推者、引用、搜索时间线等数据。  |
| 本地搜索      | 支持自然语言、精确短语、短语 slop、boost、布尔逻辑、排除、作者、文件夹、日期、数字阈值、URL/domain 与原始字段路径搜索。 |
| 研究视图      | 提供虚拟化表格视图与瀑布流媒体视图，适合查看大型书签库和媒体资料。                                                      |
| 可移植 Bundle | 可导出标准 ZIP Bundle，并在 Bundle Library 中隔离导入、查看和搜索，不会修改真实 X 账号状态。                            |
| 导出与诊断    | 支持 JSON/CSV/HTML、Bundle ZIP、媒体导出、搜索历史和诊断包。                                                            |

## 安装

1. 安装用户脚本管理器，例如 [Tampermonkey](https://www.tampermonkey.net/) 或 [Violentmonkey](https://violentmonkey.github.io/)。
2. 安装最新版本：

```text
https://github.com/kmccleary3301/scrollmark/releases/latest/download/scrollmark.user.js
```

3. 打开或强制刷新 `https://x.com/home`。
4. 确认页面上出现 Scrollmark 浮动入口，并且面板标题显示：

```text
Scrollmark
By Kyle McCleary
```

## 使用边界

- Scrollmark 只能解析 X 网页版实际加载到浏览器中的数据。
- 数据默认存储在本地浏览器 IndexedDB 中，不会自动上传到云端。
- 导入 Bundle 只会进入本地 Bundle Library，不会创建真实书签、点赞、关注或修改 X 账号。
- 如果 X 更改 GraphQL/API 响应结构，某些解析器可能需要更新。

## 相关文档

- 主 README：[`../README.md`](../README.md)
- Bundle 格式：[`bundles/canonical-bundle-v1.md`](bundles/canonical-bundle-v1.md)
- 统一 QC 流程：[`release/unified-qc-session-runbook.md`](release/unified-qc-session-runbook.md)
- 性能门槛：[`release/final-hill-performance-gates.md`](release/final-hill-performance-gates.md)
