# dsh-purge 个人 fork

上游：[YuJunZhiXue/dsh-purge](https://github.com/YuJunZhiXue/dsh-purge)
基线：**v1.1.86**（2026-10-31）
本机宿主：DSH Desktop **0.2.1-rc.5**

## 提交结构

```
e15fa64  local: 1.1.86 上的本机补丁（宿主根识别/并发口径/页签 UI）
fe9c8a6  upstream: v1.1.86 baseline (LF preserved via .gitattributes)
```

`fe9c8a6` 是上游原样快照，`e15fa64` 是本机补丁。跟上游时只 rebase 第二个提交。

## 上游已经吃掉的（不要再往回打）

历史上在 1.1.71 上手打过 12 处，其中 5 处上游后来做了官方实现，这版**已经不需要**：

| 曾手打 | 上游版本 | 现在的官方形态 |
|---|---|---|
| `CWD_ONLY_SUFFIX = ""` | 1.1.73 | `cwdSupported === false ? CWD_STATIC_SUFFIX : CWD_ONLY_SUFFIX` 静态回退 |
| `cordis.patch.yml` `personaSuffix: ""` | 1.1.73 | 上游文件里本来就是 `""` |
| rc.2 `requiredContexts` assemble 变体 | 1.1.73 / 1.1.86 | 补丁 #40 第一条 replacement（issue #132/#142） |
| 删 `presets/redteam/agent.cordis.yml` 的 `toolFilter` | 1.1.74 | 已删，只剩说明注释 |
| `preset-liangshen` 缺文件不判失败 | 1.1.84 | 补丁表已有 `optional: true` 机制，本 fork 仍显式标注 |

## 本 fork 保留的（上游到 1.1.86 仍没有）

| 补丁 | 文件 | 原因 |
|---|---|---|
| `isAiBase()` 放宽宿主根识别 | `lib/core.js` | rc.2 起 `dsh-agent-instructions` 不再带 `lib/`，原判定恒 false → boot 定位不到宿主根 |
| `preset-liangshen` 标 optional | `lib/core.js` | 本机没装 `@linxin666/dsh-liangshen`，缺目标不该判失败 |
| 并发口径走 `listDescendants` | `lib/redteam/agent-activity.js`（新增）、`tools.js`、`ui.js` | `listChildren` 返回的目录条目只有 `id/createdAt/mode/label`，**没有 `kind` 也没有 `activity`**，过滤恒为空 → 闸门永远看不见真实并发 |
| `maxAgentsNow` 的 store 兜底 | `lib/redteam/tools.js` | `ctx.redteam` 在 Scoped 平面会抛，静默 undefined → `settingsPathOf(undefined)` 退化成 `./settings.json` → 面板显示 5、闸门按 3 卡人 |
| 并发数字 5 秒轮询 | `lib/redteam/client.js` | 上游只在挂载时取一次快照，看起来永远 0 |
| 顶层页签（清洗 / 演练台） | `client.js` + `scripts/patch-conversation-view.mjs` | 上游仍是右侧浮层 dock；改成宿主 `conversation.view` 槽位，含 composer 遮挡处理 |
| 解除「本地靶场」目标限制 | `lib/net-scope.js` + `client.js` | 上游 `installRegionGate` 把攻击任务锁死在本机/内网：域名先解析、任一地址是公网就拦，攻击任务不点名目标也拦（unspecified 分支）。本机要打公网靶标，改成恒放行；旧判定保留为 `isRangeTargetLocalLab`，面板文案同步改成「已解除」 |

一处例外：#6「scope-aware var guard」（把宿主 `unknown prompt variable` 抛错改成跳过）**没有**移植——1.1.86 已用 `cwdSupported` 静态回退从源头消掉触发条件，暂时不需要。

## 重放补丁

```sh
node local/apply-local.mjs          # 幂等；输出 ok/skip 清单，末尾 node --check
node scripts/patch-conversation-view.mjs   # client.js 页签改造（幂等，带 vm 编译校验）
```

`apply-local.mjs` 只改工作区，不碰 `node_modules`。改动直接提交进 git，跟上游时 `rebase` 就是一次真 diff。

已装副本（`%USERPROFILE%\.dsh\profiles\<profile>\node_modules\dsh-purge`）用同一套规则重打，脚本随仓库带一份：

```powershell
powershell -NoProfile -File local\patch-installed-scope.ps1            # 应用（幂等）
powershell -NoProfile -File local\patch-installed-scope.ps1 -DryRun    # 只看状态
powershell -NoProfile -File local\patch-installed-scope.ps1 -Revert    # 回滚到 .bak
```

它只处理「解除靶场限制」这两处（`-Root` 可指向任意 dsh-purge 目录）；上游改版覆盖后重跑一次即可。门禁在宿主进程启动时挂载，改完必须**重启宿主**才生效，刷新页面只更新文案。

## 跟上游

```sh
git remote add upstream https://github.com/YuJunZhiXue/dsh-purge.git   # 只 fetch
git fetch upstream
git rebase upstream/master            # 冲突基本只会出现在 client.js
node local/apply-local.mjs            # 若上游改了锚点，这里会如实报 skip
node scripts/patch-conversation-view.mjs
```

上游发版频率参考：10-23 → 10-31 九天发了 14 个版本。

## 四个坑（fork 前必看）

1. **行尾必须 LF**。本仓库 `.gitattributes` 是 `* -text`，`core.autocrlf` 要关。dsh-purge 的注入补丁用 `\n` 做精确字符串匹配，一旦 checkout 成 CRLF，**所有宿主补丁全部失配**，表现为「清洗没有写进当前宿主」。clone 后先 `git config core.autocrlf false`。
2. **`REPO` 常量要改成自己的仓库**，否则面板「检查更新」盯的是上游：`lib/update.js` 的 `const REPO = "YuJunZhiXue/dsh-purge"` 和 `lib/redteam/ui.js` 的 `return 'YuJunZhiXue/dsh-purge'`。不改的后果是上游发新版时一键更新会把你覆盖回官方版。用 `DSH_PURGE_FORK_REPO=<owner>/dsh-purge node local/apply-local.mjs` 可自动改写。
3. **postinstall 会写 profile**。1.1.76 起 `postinstall` 自动把包名追加进 `dsh.profile.bundles`；装 fork 时 profile `package.json` 的 specifier 会变成你的 tarball URL，回滚官方要手动改回。
4. **版本号**。`package.json` 仍是 `1.1.86`。要区分「上游 1.1.86」和「本 fork」建议改成 `1.1.86-local.1`——但 `lib/update.js` 的比较逻辑对 semver 前缀敏感，改之前先看一遍 `lib/update.js` 的版本判定。

## 装到本机

```powershell
$p = "$env:USERPROFILE\.dsh\profiles\desktop"
Copy-Item "$p\cordis.patch.yml" "$p\cordis.patch.yml.pre-fork" -Force
corepack pnpm --dir $p add "https://codeload.github.com/<owner>/dsh-purge/tar.gz/refs/tags/v1.1.86-local.1" `
  --allow-build=dsh-purge --registry=https://registry.npmjs.org/
```

装完重启宿主 → dsh-purge → 清洗 → 应用。验证注入仍在：

```powershell
Get-Content "$env:TEMP\dsh-purge-desktop.log" -Tail 20 | Select-String 'assemble.rewrite'
# 期望：injectBytes 约为 20964，cwd= 后跟工作区路径，无 hostExit
```
