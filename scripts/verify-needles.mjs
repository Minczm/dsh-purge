/**
 * needle 歧义闸门（P1-3 的守卫）。
 *
 * `applyReplacementsToText` 用的是 split/join = 无上限全量替换，只有声明了 `expect` 才做命中数校验。
 * 这个脚本对**当前宿主**逐补丁统计每个 needle 在目标文件里的出现次数：
 *   · 出现 >1 次却没有 expect → 报歧义（上游多复制一份就会被一起改掉）；
 *   · expect 与实际不符 → 报漂移（上游改过，expect 需要重新标定）。
 * 退出码 1 表示有需要处理的行，可直接当 CI 步骤。
 *
 * 用法：
 *   node scripts/verify-needles.mjs [--ai-base <path>] [--json]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const core = await import(`file:///${path.join(here, "..", "lib", "core.js").replace(/\\/g, "/")}`);

const args = process.argv.slice(2);
const aiBaseArg = args.indexOf("--ai-base");
const aiBase = aiBaseArg >= 0 ? args[aiBaseArg + 1] : core.findAiBase();
const asJson = args.includes("--json");

if (!aiBase) {
  console.error("没有定位到宿主插件根（可用 --ai-base 指定）");
  process.exit(2);
}

const files = core.targetFiles(aiBase);
// core 没导出内部的 pathsOf：自己摊平 targetFiles 的值（string | string[] | {key: [...]}）。
function flattenPaths(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap(flattenPaths);
  if (typeof value === "string") return [value];
  if (typeof value === "object") return Object.values(value).flatMap(flattenPaths);
  return [];
}
const rows = [];
for (const patch of core.ALL_PATCHES) {
  const keys = Array.isArray(patch.file) ? patch.file : (patch.file ? [patch.file] : []);
  for (const key of keys) {
    const fps = flattenPaths(files[key]);
    for (const fp of fps) {
      const bak = `${fp}.dshpurge.bak`;
      const src = fs.existsSync(bak) ? bak : fp;
      let text = "";
      try {
        text = fs.readFileSync(src, "utf8");
      } catch {
        continue;
      }
      for (const rep of patch.replacements || []) {
        if (rep.pattern instanceof RegExp) continue;
        const needle = String(rep.pattern || "");
        if (!needle) continue;
        const hits = text.split(needle).length - 1;
        const declared = typeof rep.expect === "number" ? rep.expect : null;
        if (hits > 1 && declared === null) {
          rows.push({ level: "ambiguous", id: patch.id, name: patch.name, file: path.basename(path.dirname(fp)), hits, expected: null, needle: needle.slice(0, 60) });
        } else if (declared !== null && declared !== hits && hits > 0) {
          rows.push({ level: "drift", id: patch.id, name: patch.name, file: path.basename(path.dirname(fp)), hits, expected: declared, needle: needle.slice(0, 60) });
        }
      }
    }
  }
}

// 已知歧义清单：可见、不阻断（清单本身进仓，改它要写理由）。
const knownPath = path.join(here, "..", "needle-known.json");
let known = [];
try {
  known = JSON.parse(fs.readFileSync(knownPath, "utf8")).entries || [];
} catch { /* 没有清单就当空的 */ }
const isKnown = (row) => known.some((k) => k.id === row.id && String(row.needle).includes(String(k.contains)));
for (const row of rows) {
  if (isKnown(row)) row.level = "known";
}
const actionable = rows.filter((r) => r.level !== "known");

if (asJson) {
  console.log(JSON.stringify(rows, null, 2));
} else if (rows.length === 0) {
  console.log(`needle 检查通过：${core.ALL_PATCHES.length} 条补丁在 ${aiBase} 上没有歧义 needle`);
} else {
  for (const r of rows) {
    const tag = r.level === "known" ? "· 已知" : r.level === "ambiguous" ? "✗ 歧义" : "! 漂移";
    console.log(`${tag} #${r.id} ${r.name} [${r.file}] hits=${r.hits}${r.expected !== null ? ` expect=${r.expected}` : " 未声明 expect"} :: ${JSON.stringify(r.needle)}`);
  }
  console.log(`\n已知 ${rows.length - actionable.length} 行 / 待处理 ${actionable.length} 行`);
}
process.exit(actionable.length === 0 ? 0 : 1);
