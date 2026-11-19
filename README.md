# FigureDeck MCP — US mortgage data for AI agents

[![FigureDeck US Mortgage Data — MCP connector rated A on Glama](https://glama.ai/mcp/connectors/com.figuredeck/conforming-limits/badges/score.svg)](https://glama.ai/mcp/connectors/com.figuredeck/conforming-limits)

English | [简体中文](README.zh-CN.md)

An MCP server that answers three questions with sourced numbers instead of guesses:

- **What is the conforming loan limit in this county?** Calendar-year 2026 FHFA limits for 3,235 US counties, by FIPS.
- **What does this loan cost per month?** Principal, interest, and the full amortization total.
- **How much house can this income carry?** Price ceiling under a 36% DTI cap.

The first one is the point. Conforming limits are county-specific, change every year, and models
routinely get them wrong — the 2026 baseline is $832,750, but King County, WA is $1,063,750 and
four-unit properties there go to $2,045,700. There is no way to guess your way to that.

## Install

Point any Streamable HTTP client straight at the hosted endpoint — no key, no session, nothing to
install:

```
https://mcp.figuredeck.com/mcp
```

Clients that only speak stdio (Claude Desktop, most IDE plugins) can run the thin proxy in
`bin/` instead:

```bash
npx -y github:callmeyz174a/figuredeck-mcp
```

Claude Desktop (`claude_desktop_config.json`):

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

The proxy forwards every call to the hosted endpoint. Nothing is cached locally, so you never get
a stale copy of the limits.

## Tools

| Tool | Arguments | Returns |
|---|---|---|
| `search_conforming_limits` | `county` (e.g. `"King County, WA"`) | 2026 limit for 1–4 unit homes, baseline, FIPS, source |
| `mortgage_payment` | `loan_amount`, `annual_rate_percent`, `term_years` | Monthly P&I, total paid, total interest, first-month split |
| `affordability` | `monthly_income`, `annual_rate_percent`, `term_years`, `monthly_debts`, `down_payment` | Max loan, max purchase price, DTI assumption |

Real response, not a mock:

```
$ search_conforming_limits {"county": "King County, WA"}
King County, WA (FIPS 53033): the 2026 conforming limit is $1,063,750 for a one-unit
home, $1,361,800 for two units, $1,646,100 for three and $2,045,700 for four.
That is $231,000 above the $832,750 baseline.
Source: FHFA county file for calendar year 2026.
```

## Data

Conforming limits come from the **FHFA county-level conforming loan limit file**, calendar year
2026. Public domain, published annually in late November. The endpoint is stateless and always
serves the current year's file — there is no bundled snapshot to go stale.

Rates are never baked in as defaults. Every tool takes the rate from you, so results are
reproducible and do not silently drift with the market.

County lookups accept `"King County, WA"`, `"king county wa"`, or a 5-digit FIPS code. The `, WA`
suffix matters — without state disambiguation, identically named counties collide.

## Verify it yourself

The test ships with the package, so this works from a clone or from an install:

```bash
npm install   # no dependencies, this just wires up the script
npm run smoke
```

Nine assertions over the real protocol, including exact dollar amounts: `$1,063,750` for King
County and `$2,528/month` for a $400,000 loan at 6.5%. If the data changes, this goes red on
purpose. A check that only asserts "the server responded" would stay green while serving garbage,
which is the failure mode worth guarding against.

Point it at a local build instead of production:

```bash
FD_MCP_URL=http://127.0.0.1:8788/mcp npm run smoke
```

## What is in this repository

| Path | What it is |
|---|---|
| `bin/figuredeck-mcp.js` | stdio → Streamable HTTP proxy, the only code you run locally |
| `test/smoke.js` | nine live assertions against the public endpoint |
| `server.json` | MCP Registry manifest for `com.figuredeck/conforming-limits` |
| `README.md`, `README.zh-CN.md` | this document, in English and Chinese |

This repository deliberately contains the client-facing surface only. The server implementation and
the mortgage calculators behind these numbers are not published here; the hosted endpoint is the
interface, and it is the thing under test.

## License

Code: MIT. Data: public domain (FHFA). Attribution appreciated but not required.

The same numbers are available as flat files if you would rather not speak MCP:

- <https://figuredeck.com/data/conforming-limits-2026.csv>
- <https://figuredeck.com/data/conforming-limits-2026.json> (includes FIPS, county, state, 1–4 unit limits)
