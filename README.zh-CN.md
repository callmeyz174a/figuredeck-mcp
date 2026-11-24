# FigureDeck MCP 工具 — 用真实数据回答美国房贷问题

[![FigureDeck US Mortgage Data — MCP connector rated A on Glama](https://glama.ai/mcp/connectors/com.figuredeck/conforming-limits/badges/score.svg)](https://glama.ai/mcp/connectors/com.figuredeck/conforming-limits) [![FigureDeck MCP on Glama](https://glama.ai/mcp/servers/callmeyz174a/figuredeck-mcp/badges/score.svg)](https://glama.ai/mcp/servers/callmeyz174a/figuredeck-mcp)

[English](README.md) | 简体中文

一个 MCP 服务，用带来源的实数回答三个问题，而不是让模型去猜：

- **这个县的可合规贷款上限（conforming loan limit）是多少？** 2026 年度 FHFA 县表，覆盖全美 3,235 个县，按 FIPS 查询。
- **这笔贷款每月要还多少？** 本金、利息，以及整个摊还期的总额。
- **这份收入能撑起多贵的房子？** 在 36% DTI 上限下的房价天花板。

第一条才是重点。可合规上限按县不同、每年调整，模型几乎必然会记错——2026 年的基准值是
$832,750，但华盛顿州 King 县是 $1,063,750，当地四户住宅可到 $2,045,700。这个数猜不出来。

## 接入方式

任何支持 Streamable HTTP 的客户端可以直接连托管端点，不需要 key、不需要会话、不用装任何东西：

```
https://mcp.figuredeck.com/mcp
```

只支持 stdio 的客户端（Claude Desktop、多数 IDE 插件）改用 `bin/` 里的薄代理：

```bash
npx -y github:callmeyz174a/figuredeck-mcp
```

Claude Desktop 的 `claude_desktop_config.json`：

```json
{
  "mcpServers": {
    "figuredeck": {
      "command": "npx",
      "args": ["-y", "github:callmeyz174a/figuredeck-mcp"]
    }
  }
}
```

代理把每次调用原样转给托管端点，本地不缓存任何数据，所以不会出现「装了个旧版上限表」的情况。

代理会带上 `figuredeck-mcp-stdio/1.0` 这个 UA，端点靠它区分「经代理调用」与「直连」。想换成自己的
就设 `FD_MCP_UA`。端点只记这个字符串，不记参数，也不记你输入的金额。

## 三个工具

| 工具 | 参数 | 返回 |
|---|---|---|
| `search_conforming_limits` | `county`（例如 `"King County, WA"`） | 2026 年 1–4 户住宅上限、基准值、FIPS、数据来源 |
| `mortgage_payment` | `loan_amount`、`annual_rate_percent`、`term_years` | 每月本息、还款总额、利息总额、首月拆分 |
| `affordability` | `monthly_income`、`annual_rate_percent`、`term_years`、`monthly_debts`、`down_payment` | 最大贷款额、最大房价、DTI 假设 |

以下是一次真实返回，不是编的示例：

```
$ search_conforming_limits {"county": "King County, WA"}
King County, WA (FIPS 53033): the 2026 conforming limit is $1,063,750 for a one-unit
home, $1,361,800 for two units, $1,646,100 for three and $2,045,700 for four.
That is $231,000 above the $832,750 baseline.
Source: FHFA county file for calendar year 2026.
```

## 数据来源

可合规上限来自 **FHFA 县级 conforming loan limit 文件**，2026 年度。属公共领域，每年 11 月下
旬发布。端点是 stateless 的，永远返回当年那份文件——没有本地快照会过期。

利率不会被写死成默认值。每个工具都要你自己传利率，所以结果可复现，也不会随市场悄悄漂移。

县名支持 `"King County, WA"`、`"king county wa"` 或 5 位 FIPS 码。`, WA` 这个州后缀是必要的——
同名县在去掉州之后会撞在一起。

## 自己验一遍

测试脚本随包发布，克隆后或安装后都能跑：

```bash
npm install   # 无依赖，这一步只是挂上脚本
npm run smoke
npm run test:ua   # 离线：断言代理实际发出的 UA
```

走真实协议跑九条断言，断言的是具体金额：King 县 `$1,063,750`，40 万美元贷款 6.5% 利率的月供
`$2,528`。数据一变它就红，这个红是故意的。只断言「服务端有响应」的检查，在服务端返回垃圾时
依然是绿的——那才是最该防的失效方式。

也可以打本地构建而不是生产端点：

```bash
FD_MCP_URL=http://127.0.0.1:8788/mcp npm run smoke
```

CI 只跑离线那一半：每个入口 `node --check`，加上 node 20/22 各跑一遍 `test/ua.js`。
`test/smoke.js` **故意不进 CI**：它要出网、会因与代码无关的原因变红，而且每跑一次都在服务端
公开的调用计数上加一。一个会把被验数字自己抬高的检查，比没有检查更糟，所以 smoke 保留为发布
前手动跑的一步。

## 这个仓库里有什么

| 路径 | 内容 |
|---|---|
| `bin/figuredeck-mcp.js` | stdio → Streamable HTTP 代理，唯一在你本机运行的代码 |
| `test/smoke.js` | 针对公开端点的九条实时断言 |
| `test/ua.js` | 离线断言：代理实际发出的请求头 |
| `.github/workflows/ci.yml` | 语法检查 + `test/ua.js`，node 20 与 22，全离线 |
| `server.json` | MCP Registry 清单，`com.figuredeck/conforming-limits` |
| `README.md`、`README.zh-CN.md` | 本文档，英文与中文各一份 |

这个仓库只放对外的接口层。服务端实现和产出这些数字的房贷计算器不在本仓发布；托管端点才是
接口，也是被测试的对象。

## 授权

代码 MIT。数据属公共领域（FHFA）。欢迎署名，但非必须。

如果你不想走 MCP，同样的数字也提供平铺文件：

- <https://figuredeck.com/data/conforming-limits-2026.csv>
- <https://figuredeck.com/data/conforming-limits-2026.json>（含 FIPS、县、州、1–4 户上限）

---

*中英文两版内容一致；若两者出现分歧，以 `README.md` 为准。*
