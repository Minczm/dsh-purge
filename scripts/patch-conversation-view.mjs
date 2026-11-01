/**
 * dsh-purge 适配：顶层页签（conversation.view）+ 下线浮层入口 + 修好报告页滚动。
 * 幂等；写完用 vm.Script 编译校验，失败不落盘。
 *
 * 用法：node scripts/patch-conversation-view.mjs [client.js 路径]
 */
import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const target = resolve(process.argv[2] || join(here, "..", "client.js"));

const NEW_VIEW = "\t\t/* 会话区顶层页签（宿主 conversation.view 槽位，内置「对话」页也是这么挂的）。\n\t\t   高度由宿主的 viewArea 给，这里只负责撑满 + 让内部各自滚动。\n\t\t   注意：不要在这里写 overflow:hidden!important —— 会把报告页的内联 overflow:auto 一起压掉。 */\n\t\tconst VIEW_CSS = `\n.dshp-view{display:flex;flex-direction:column;flex:1;min-height:0;height:100%;overflow:hidden;background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-primary)}\n.dshp-view .dshp-root{flex:1;min-height:0;max-width:none;height:100%;overflow:auto;background:transparent!important}\n.dshp-view .rt-dock.rt-embedded{flex:1;min-height:0;width:100%;height:100%}\n.dshp-view .rt-head,.dshp-view .rt-tabs,.dshp-view .rt-foot{flex:none}\n.dshp-view .rt-body{flex:1;min-height:0}\n.dshp-view .rt-main{flex:1;min-height:0;overflow:hidden}\n/* 底部输入框属于「对话」页，而且在宿主里是绝对定位的浮层：本页签激活时收掉，否则会盖住表格最后几行。\n   但审批 / 提问 / 计划确认这几类卡片也挂在 composer 上，出现时必须放回来（下面两条规则选择器更具体，会覆盖收起）。 */\n[data-conversation-region=\"chat\"]:has(.dshp-view) [data-conversation-region=\"composer\"]{display:none!important}\n[data-conversation-region=\"chat\"]:has(.dshp-view) [data-conversation-region=\"composer\"]:has([data-approval-key]),\n[data-conversation-region=\"chat\"]:has(.dshp-view) [data-conversation-region=\"composer\"]:has([data-question-key]),\n[data-conversation-region=\"chat\"]:has(.dshp-view) [data-conversation-region=\"composer\"]:has([data-plan-review-key]){display:flex!important}\n.dshp-view-note{padding:18px 20px;font-size:13px;line-height:1.8;color:var(--dsw-alias-label-secondary)}\n.dshp-view-note b{display:block;margin-bottom:6px;font-size:14px;color:var(--dsw-alias-label-primary)}\n.dshp-view-note .dshp-view-ops{margin-top:14px}\n`;\n\n\t\t/* 浮层下线后，样式和授权弹窗还需要一个常驻宿主：样式注入一次，\n\t\t   授权弹窗只看 authOpen（它自己 portal 到 body，不占布局）。 */\n\t\tfunction PurgeStyleHost() {\n\t\t\tuseEffect(() => {\n\t\t\t\tif (typeof document === \"undefined\") return undefined;\n\t\t\t\tconst ensure = (attr, css) => {\n\t\t\t\t\tif (!css) return;\n\t\t\t\t\tif (document.querySelector(\"style[\" + attr + \"]\")) return;\n\t\t\t\t\tconst tag = document.createElement(\"style\");\n\t\t\t\t\ttag.setAttribute(attr, \"1\");\n\t\t\t\t\ttag.textContent = css;\n\t\t\t\t\tdocument.head.append(tag);\n\t\t\t\t};\n\t\t\t\tensure(\"data-dsh-purge-ui\", PURGE_CSS);\n\t\t\t\tif (__dshPurgeDrill && __dshPurgeDrill.CSS) ensure(\"data-dsh-purge-drill\", __dshPurgeDrill.CSS);\n\t\t\t\treturn undefined;\n\t\t\t}, []);\n\t\t\treturn null;\n\t\t}\n\n\t\tfunction PurgeGateHost() {\n\t\t\tuseDock();\n\t\t\treturn dockBus.authOpen ? h(AuthGate, { pending: dockBus.pending }) : null;\n\t\t}\n\n\t\tfunction PurgeCleanView(props) {\n\t\t\tconst t = useT();\n\t\t\t/* 捕获宿主给的 openView：其它入口（首页 chip / 输入框按钮）靠它切页签 */\n\t\t\tuseEffect(() => { purgeOpenViewPatch(props && props.openView); }, [props && props.openView]);\n\t\t\treturn h(\"div\", { className: \"dshp-view\", \"data-dshp-view\": \"clean\" },\n\t\t\t\th(\"style\", null, VIEW_CSS),\n\t\t\t\th(SettingsRoot, { t }),\n\t\t\t);\n\t\t}\n\n\t\tfunction PurgeDrillView(props) {\n\t\t\tconst t = useT();\n\t\t\tuseEffect(() => { purgeOpenViewPatch(props && props.openView); }, [props && props.openView]);\n\t\t\t/* 订阅 dockBus：授权确认时会 setDrillAuthLocal(true) + setDock(...)，\n\t\t\t   订阅到就能切回演练台，不用自己轮询。 */\n\t\t\tuseDock();\n\t\t\tconst ready = Boolean(readDrillAuth() && __dshPurgeDrill && __dshPurgeDrill.Panel);\n\t\t\treturn h(\"div\", { className: \"dshp-view\", \"data-dshp-view\": \"drill\" },\n\t\t\t\th(\"style\", null, VIEW_CSS),\n\t\t\t\tready\n\t\t\t\t\t? h(__dshPurgeDrill.Panel, { embedded: true })\n\t\t\t\t\t: h(\"div\", { className: \"dshp-view-note\" },\n\t\t\t\t\t\th(\"b\", null, t(\"dock.drill\")),\n\t\t\t\t\t\th(\"div\", null, t(\"dock.unauthorized\")),\n\t\t\t\t\t\th(\"div\", { className: \"dshp-view-ops\" },\n\t\t\t\t\t\t\th(\"button\", {\n\t\t\t\t\t\t\t\ttype: \"button\",\n\t\t\t\t\t\t\t\tclassName: \"dshp-btn dshp-btn-primary\",\n\t\t\t\t\t\t\t\tonClick: () => setDock({ open: false, tab: \"drill\", authOpen: true, pending: \"tab\" }),\n\t\t\t\t\t\t\t}, t(\"view.grant\")),\n\t\t\t\t\t\t),\n\t\t\t\t\t),\n\t\t\t);\n\t\t}\n\n";
const OLD_ENTRY = "\t\tfunction openDockClean() {\n\t\t\tsetDock({ open: true, tab: \"clean\", authOpen: false, pending: \"tab\" });\n\t\t}\n\t\tfunction toggleDock() {\n\t\t\tif (dockBus.open) setDock({ open: false, authOpen: false, pending: \"tab\" });\n\t\t\telse openDockClean();\n\t\t}";
const NEW_ENTRY = "\t\tfunction openDockClean() {\n\t\t\tsetDock({ open: false, tab: \"clean\", authOpen: false, pending: \"tab\" });\n\t\t\tshowPurgeTab(\"clean\");\n\t\t}\n\t\tfunction toggleDock() {\n\t\t\tshowPurgeTab(\"clean\");\n\t\t}\n\n\t\t/* 页签取代浮层后的统一跳转：\n\t\t   openView 由宿主作为 props 传给 conversation.view 组件，挂载时捕获；\n\t\t   还没捕获到（当前停在「对话」页、我们的 view 从没挂过）就退回点 DOM 里的页签按钮。 */\n\t\tlet purgeOpenView = null;\n\t\tfunction purgeTabLabel(which) {\n\t\t\treturn translate(which === \"clean\" ? \"dock.clean\" : \"dock.drill\");\n\t\t}\n\t\tfunction showPurgeTab(which) {\n\t\t\tconst want = which === \"drill\" ? \"drill\" : \"clean\";\n\t\t\tconst id = want === \"clean\" ? \"dsh-purge-clean\" : \"dsh-purge-drill\";\n\t\t\t/* 先点 DOM 里的页签：那永远是当前会话的 tab，不会因为捕获到旧 openView 切错会话 */\n\t\t\ttry {\n\t\t\t\tconst label = purgeTabLabel(want);\n\t\t\t\tconst tabs = Array.prototype.slice.call(\n\t\t\t\t\tdocument.querySelectorAll('[data-conversation-tabs] [role=\"tab\"]'),\n\t\t\t\t);\n\t\t\t\tconst hit = tabs.find((el) => String(el.textContent || \"\").trim() === label);\n\t\t\t\tif (hit) { hit.click(); return true; }\n\t\t\t} catch { /* 落到 openView 兜底 */ }\n\t\t\tif (typeof purgeOpenView === \"function\") {\n\t\t\t\ttry { purgeOpenView(id, \"\"); return true; } catch { /* ignore */ }\n\t\t\t}\n\t\t\treturn false;\n\t\t}\n\t\tfunction purgeOpenViewPatch(fn) {\n\t\t\tif (typeof fn === \"function\") purgeOpenView = fn;\n\t\t}";
const OLD_REQ = "\t\tfunction requestDrill(kind) {\n\t\t\tconst pending = kind || \"tab\";\n\t\t\tconst openEnv = () => {\n\t\t\t\ttry {\n\t\t\t\t\tif (__dshPurgeDrill && __dshPurgeDrill.setUI) {\n\t\t\t\t\t\t__dshPurgeDrill.setUI({ open: true, tab: \"env\" });\n\t\t\t\t\t}\n\t\t\t\t} catch { /* ignore */ }\n\t\t\t};\n\t\t\tif (readDrillAuth()) {\n\t\t\t\tsetDock({ open: true, tab: \"drill\", authOpen: false, pending: \"tab\" });\n\t\t\t\ttry { if (__dshPurgeDrill && __dshPurgeDrill.setUI) __dshPurgeDrill.setUI({ open: true }); } catch { /* ignore */ }\n\t\t\t\tif (pending === \"env\") openEnv();\n\t\t\t\tif (pending === \"full\") {\n\t\t\t\t\ttry { window.open(window.location.href.split(\"#\")[0] + \"#redteam-full\", \"_blank\", \"noopener\"); } catch { /* ignore */ }\n\t\t\t\t}\n\t\t\t\treturn;\n\t\t\t}\n\t\t\t/* 未授权：直接切到演练台页签并弹出授权窗（不再停在清洗页，避免像「没触发」） */\n\t\t\tsetDock({ open: true, tab: \"drill\", authOpen: true, pending: pending });\n\t\t}";
const NEW_REQ = "\t\t/* 浮层已下线：所有入口统一跳顶部页签（清洗 / 演练台）。\n\t\t   未授权时只拉起授权窗，授权确认后由 AuthGate 负责切到演练台。 */\n\t\tfunction requestDrill(kind) {\n\t\t\tconst pending = kind || \"tab\";\n\t\t\tconst authorized = readDrillAuth();\n\t\t\tsetDock({ open: false, tab: \"drill\", authOpen: !authorized, pending: pending });\n\t\t\tshowPurgeTab(\"drill\");\n\t\t\tif (!authorized) return;\n\t\t\ttry { if (__dshPurgeDrill && __dshPurgeDrill.setUI) __dshPurgeDrill.setUI({ open: true }); } catch { /* ignore */ }\n\t\t\tif (pending === \"env\") {\n\t\t\t\ttry { if (__dshPurgeDrill && __dshPurgeDrill.setUI) __dshPurgeDrill.setUI({ open: true, tab: \"env\" }); } catch { /* ignore */ }\n\t\t\t}\n\t\t}";
const NEW_APPLY = "\t\t\t}, () => h(react.Fragment, null, h(PurgeStyleHost), h(WelcomeNotice), h(PurgeGateHost), h(HeroNewSessionMount), h(TabRowPurgeMount), h(EnvAdaptSendGate))));";
const OLD_APPLY = "\t\t\t}, () => h(react.Fragment, null, h(WelcomeNotice), h(PurgeLauncher), h(PurgeDock), h(HeroNewSessionMount), h(TabRowPurgeMount), h(EnvAdaptSendGate))));";
const OLD_SYNC = "setDock({ open: true, tab: \"drill\", authOpen: true, pending: dockBus.pending || \"tab\" });";
const NEW_SYNC = "setDock({ open: false, tab: \"drill\", authOpen: true, pending: dockBus.pending || \"tab\" });";
const OLD_AUTH = "setDock({ authOpen: false, open: true, tab: \"drill\", pending: \"tab\" });";
const NEW_AUTH = "setDock({ authOpen: false, open: false, tab: \"drill\", pending: \"tab\" });\n\t\t\t\t\t\t\t\tshowPurgeTab(\"drill\");";
const OLD_FULL = "\n\t\t\t\t\t\t\t\tif (kind === \"full\") {\n\t\t\t\t\t\t\t\t\ttry { window.open(window.location.href.split(\"#\")[0] + \"#redteam-full\", \"_blank\", \"noopener\"); } catch { /* ignore */ }\n\t\t\t\t\t\t\t\t}";

const CSS_FROM = ".dshp-dock-body .rt-body{flex:1;min-height:0;overflow:hidden!important;background:transparent!important}";
const CSS_TO = ".dshp-dock-body .rt-embedded>.rt-body{flex:1;min-height:0;overflow:hidden!important;background:transparent!important}";
const BODY_FROM = `			const body = st.tab === "clean"
				? h(SettingsRoot, { t })
				: (readDrillAuth() && __dshPurgeDrill.Panel
					? h(__dshPurgeDrill.Panel, { embedded: true })
					: h("div", { style: { padding: 16, color: "var(--dsw-alias-label-secondary)" } }, t("dock.unauthorized")));`;
const BODY_TO = `			/* 演练台浮层只在这一层可见时挂载：页签里已经有一份，收起后再挂一份就是双份轮询。 */
			const body = st.tab === "clean"
				? h(SettingsRoot, { t })
				: !st.open
					? null
					: (readDrillAuth() && __dshPurgeDrill.Panel
						? h(__dshPurgeDrill.Panel, { embedded: true })
						: h("div", { style: { padding: 16, color: "var(--dsw-alias-label-secondary)" } }, t("dock.unauthorized")));`;
const APPLY_ANCHOR = '}, () => h(react.Fragment, null, h(WelcomeNotice), h(PurgeLauncher), h(PurgeDock), h(HeroNewSessionMount), h(TabRowPurgeMount), h(EnvAdaptSendGate))));';
const REGISTER_BLOCK = "\t\t\t/* 顶层页签：清洗 / 演练台 挂到宿主的 conversation.view 槽位（内置「对话」页用的是同一个）。\n\t\t\t   老宿主没有这个槽位时 inject 不会触发；浮层入口已下线，此时只能靠首页 chip / 输入框按钮提示。 */\n\t\t\ttry {\n\t\t\t\tconst registerView = (id, order, label, component) => {\n\t\t\t\t\tctx.slots.inject(\"conversation.view\", () => ctx.slots.register({\n\t\t\t\t\t\tname: \"conversation.view\",\n\t\t\t\t\t\tid,\n\t\t\t\t\t\torder,\n\t\t\t\t\t\tlabel,\n\t\t\t\t\t}, component));\n\t\t\t\t};\n\t\t\t\tregisterView(\"dsh-purge-clean\", 20, () => t(\"dock.clean\"), PurgeCleanView);\n\t\t\t\tregisterView(\"dsh-purge-drill\", 21, () => t(\"dock.drill\"), PurgeDrillView);\n\t\t\t} catch { /* 槽位不可用：保持原有浮层 */ }";

let src = readFileSync(target, "utf8");
const before = src;
const steps = [];
const ok = (m) => steps.push("ok: " + m);
const skip = (m) => steps.push("skip: " + m);
const apply = (from, to, label) => {
  if (!src.includes(from)) { skip(label + "（未匹配，上游可能已改）"); return false; }
  src = src.split(from).join(to);
  ok(label);
  return true;
};

if (src.includes(CSS_TO)) skip("滚动修复已存在"); else apply(CSS_FROM, CSS_TO, "收窄 overflow 覆盖，修好报告页滚动");
if (src.includes("data-dshp-view")) skip("页签组件已存在");
else {
  const at = src.indexOf("\t\tfunction PurgeDock() {");
  if (at < 0) skip("没找到 PurgeDock 插入点");
  else { src = src.slice(0, at) + NEW_VIEW + src.slice(at); ok("插入页签视图 + 样式/授权宿主"); }
}
if (src.includes("双份轮询")) skip("浮层双挂载守卫已存在"); else apply(BODY_FROM, BODY_TO, "浮层收起时不再挂载演练台");
if (src.includes("dsh-purge-clean")) skip("conversation.view 注册已存在"); else apply(APPLY_ANCHOR, APPLY_ANCHOR + "\n" + REGISTER_BLOCK, "注册 conversation.view 两个页签");
if (src.includes(NEW_APPLY)) skip("浮层入口已下线"); else apply(OLD_APPLY, NEW_APPLY, "shell.overlay 去掉浮层与右下角按钮");
apply(OLD_ENTRY, NEW_ENTRY, "入口改跳页签（openDockClean/toggleDock/showPurgeTab）");
apply(OLD_REQ, NEW_REQ, "requestDrill 改跳页签");
apply(OLD_SYNC, NEW_SYNC, "授权失效时不再拉起浮层");
apply(OLD_AUTH, NEW_AUTH, "授权确认后跳演练台页签");
apply(OLD_FULL, "", "去掉「全面浏览」新窗口分支");
if (src.includes('"view.grant": "去授权"')) skip("zh 文案键已存在"); else apply('"dock.unauthorized": "未授权",', '"dock.unauthorized": "未授权",\n\t\t\t"view.grant": "去授权",', "补 view.grant（zh）");
if (src.includes('"view.grant": "Grant access"')) skip("en 文案键已存在"); else apply('"dock.unauthorized": "Unauthorized",', '"dock.unauthorized": "Unauthorized",\n\t\t\t"view.grant": "Grant access",', "补 view.grant（en）");

try { new vm.Script(src, { filename: target }); } catch (error) { console.error("编译校验失败，已放弃写入：" + error.message); process.exit(1); }
if (src === before) { console.log("没有变化：\n" + steps.join("\n")); process.exit(0); }
const backup = target + ".bak-patch-" + new Date().toISOString().replace(/\D/g, "").slice(0, 14);
copyFileSync(target, backup);
writeFileSync(target, src);
console.log("已写入 " + target + "（备份 " + backup + "）\n" + steps.join("\n"));
