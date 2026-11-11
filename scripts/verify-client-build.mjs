/**
 * 构建一致性闸门 —— 供 CI / 发版前跑。
 *
 * 背景（P1-2）：client.js 是「手写外壳 + 由 lib/redteam/client.js 拼进 DRILL 段」的混合产物。
 * 一旦改了 lib/redteam/client.js 却没重跑 build，仓里的 client.js 就落后于源码；
 * 反过来，如果有人手改 DRILL 段，下一次 build 会把它冲掉。两边都发生过，
 * 所以这里做一次「重建后是否与仓里字节相同」的断言。校验本身零副作用（不一致会还原）。
 *
 * 用法：
 *   node scripts/verify-client-build.mjs          # 校验，不一致退出码 1
 *   node scripts/verify-client-build.mjs --write  # 直接重建并落盘
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const clientPath = join(root, "client.js");
const buildArgs = [join(root, "scripts", "build-client.mjs")];

if (process.argv.includes("--write")) {
  execFileSync(process.execPath, buildArgs, { stdio: "inherit" });
  console.log("client.js 已重建");
  process.exit(0);
}

const before = readFileSync(clientPath);
try {
  execFileSync(process.execPath, buildArgs, { stdio: "ignore" });
  const rebuilt = readFileSync(clientPath);
  if (!rebuilt.equals(before)) {
    writeFileSync(clientPath, before);
    console.error(
      "client.js 与 lib/redteam/client.js 不一致：请跑 `node scripts/build-client.mjs` 并把产物一起提交。\n"
      + `仓里 ${before.length} 字节，重建 ${rebuilt.length} 字节。`,
    );
    process.exit(1);
  }
  console.log("client.js 与源码一致（构建幂等）");
} catch (e) {
  try { writeFileSync(clientPath, before); } catch { /* 还原失败时至少报错 */ }
  console.error("构建校验失败：", String(e && e.message ? e.message : e));
  process.exit(2);
}
