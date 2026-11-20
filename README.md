# github-core-clone-01 — a standalone GitHub-compatible git forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/gregorionainggolan8-tech/makefun-github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/gregorionainggolan8-tech/makefun-github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

One Node process (stdlib only, no git binary, no network) serving git smart HTTP
(upload-pack v2, receive-pack v0), REST v3, GraphQL v4 and MCP from its own
in-memory store. Built for [the make.fun bounty](https://make.fun/bounty/github-core-clone-01).

Run it with `node --experimental-strip-types main.ts` (Node 22+); it binds an
ephemeral port, registers it with `$MAKEFUN_ENV_URL`, and exits 0 when the suite
says the trial is done.
