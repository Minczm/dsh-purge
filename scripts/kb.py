#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
kb.py — 本地 POC 知识库 CLI

背景：dsh-purge v1.1.86 起在工具层硬编码 `KB_DISABLED`，redteam_poc_* 全部返回
「开源版已下架知识库」。但 knowledge.db 与 FTS5 索引完好，本工具直接读写它。

数据: %USERPROFILE%\\.dsh\\redteam\\knowledge.db

用法:
  python kb.py list                     列出全部（按已验证 / 复用次数排序）
  python kb.py search <关键词>          全文搜索（FTS5）
  python kb.py get <id|code>            取全文
  python kb.py cat <category>           按归类筛
  python kb.py add --file poc.json      新增（JSON）
  python kb.py stats                    统计
  python kb.py export <目录>            全量导出为 Markdown

输出统一 UTF-8，避免 PowerShell 控制台乱码。
"""
import argparse
import json
import os
import sqlite3
import sys
from datetime import datetime

# ---- UTF-8 输出 ----
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

DB = os.path.expanduser(r"~\.dsh\redteam\knowledge.db")

CATEGORIES = [
    "rce", "deserialization", "file-upload", "sqli", "unauthorized",
    "auth-bypass", "weak-password", "ssrf", "xxe", "path-traversal",
    "info-leak", "privesc", "tunnel", "other",
]


def connect():
    if not os.path.exists(DB):
        sys.exit(f"[!] 找不到知识库: {DB}")
    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row
    return con


def cmd_list(args):
    con = connect()
    cur = con.cursor()
    sql = """select id, code, title, category, cve, component, kind, verified, hit_count
             from poc order by verified desc, hit_count desc, id"""
    rows = cur.fetchall()
    print(f"共 {len(rows)} 条  ({DB})\n")
    print(f"{'id':<4} {'title':<34} {'category':<15} {'cve':<18} {'kind':<8} {'ver':<4} hit")
    print("-" * 100)
    for r in rows:
        title = (r["title"] or "")[:32]
        cat = (r["category"] or "")[:13]
        cve = (r["cve"] or "")[:16]
        kind = (r["kind"] or "")[:8]
        ver = "Y" if r["verified"] else "-"
        print(f"{r['id']:<4} {title:<34} {cat:<15} {cve:<18} {kind:<8} {ver:<4} {r['hit_count'] or 0}")
    con.close()


def cmd_search(args):
    con = connect()
    cur = con.cursor()
    q = " ".join(args.keyword)
    # FTS5 语法容错：把用户输入当词序列 AND
    safe = " ".join(f'"{w}"' for w in q.split() if w.strip())
    try:
        cur.execute("""
            select p.id, p.code, p.title, p.category, p.cve, p.component,
                   p.kind, p.verified, p.hit_count, length(p.content) as clen,
                   snippet(poc_fts, 7, '[', ']', '…', 12) as snip
            from poc_fts f join poc p on p.id = f.poc_id
            where poc_fts match ?
            order by p.verified desc, p.hit_count desc, rank
            limit 30
        """, (safe,))
        rows = cur.fetchall()
    except sqlite3.OperationalError:
        # 退化到 LIKE
        like = f"%{q}%"
        cur.execute("""
            select id, code, title, category, cve, component, kind, verified,
                   hit_count, length(content) as clen, '' as snip
            from poc
            where title like ? or description like ? or content like ?
               or component like ? or tags like ?
            order by verified desc, hit_count desc, id limit 30
        """, (like, like, like, like, like))
        rows = cur.fetchall()

    if not rows:
        print(f"[ ] 无命中: {q}")
        con.close()
        return
    print(f"命中 {len(rows)} 条  (query: {q})\n")
    for r in rows:
        ver = "已验证" if r["verified"] else "未验证"
        print(f"[{r['id']}] {r['title']}")
        print(f"     {r['kind']} · {r['category']} · {ver} · 复用 {r['hit_count'] or 0} 次 · {r['clen']} 字节")
        if r["cve"]:
            print(f"     CVE: {r['cve']}  组件: {r['component'] or '-'}")
        if r["snip"]:
            print(f"     {r['snip'][:160]}")
        print()
    con.close()


def cmd_get(args):
    con = connect()
    cur = con.cursor()
    key = args.key
    if key.isdigit():
        cur.execute("select * from poc where id = ?", (int(key),))
    else:
        cur.execute("select * from poc where code = ?", (key,))
    r = cur.fetchone()
    if not r:
        print(f"[!] 没有 id/code = {key}")
        con.close()
        return

    print("=" * 78)
    print(f"# {r['title']}")
    print("=" * 78)
    meta = [
        ("id", r["id"]), ("code", r["code"]), ("kind", r["kind"]),
        ("category", r["category"]), ("cve", r["cve"]), ("component", r["component"]),
        ("versions", r["versions"]), ("severity", r["severity"]), ("language", r["language"]),
        ("source", r["source"]), ("source_url", r["source_url"]),
        ("verified", "是" if r["verified"] else "否"),
        ("hit_count", r["hit_count"]), ("engagement", r["engagement_name"]),
        ("asset_target", r["asset_target"]), ("tags", r["tags"]),
        ("created_at", r["created_at"]),
    ]
    for k, v in meta:
        if v not in (None, ""):
            print(f"{k:<14}: {v}")
    print()
    if r["description"]:
        print("## 描述\n" + r["description"] + "\n")
    if r["usage"]:
        print("## 用法\n" + r["usage"] + "\n")
    if r["verified_note"]:
        print("## 验证记录\n" + r["verified_note"] + "\n")
    if r["content"]:
        print("## 正文")
        print("-" * 78)
        print(r["content"])
        print("-" * 78)
    if r["path"]:
        print(f"\n落盘: {r['path']}")

    # 记一次复用
    try:
        cur.execute("update poc set hit_count = coalesce(hit_count,0)+1 where id = ?", (r["id"],))
        con.commit()
    except Exception:
        pass
    con.close()


def cmd_cat(args):
    con = connect()
    cur = con.cursor()
    cur.execute("""select id, title, cve, kind, verified from poc
                   where category = ? order by verified desc, id""", (args.category,))
    rows = cur.fetchall()
    print(f"category = {args.category}  ({len(rows)} 条)\n")
    for r in rows:
        ver = "Y" if r["verified"] else "-"
        print(f"  [{r['id']}] {ver} {r['title']}  {r['cve'] or ''}")
    con.close()


def cmd_stats(args):
    con = connect()
    cur = con.cursor()
    print(f"库: {DB}  ({os.path.getsize(DB):,} 字节)\n")
    cur.execute("select count(*) from poc")
    print("总条数:", cur.fetchone()[0])
    cur.execute("select count(*) from poc where verified = 1")
    print("已验证:", cur.fetchone()[0])
    print("\n按归类:")
    cur.execute("select category, count(*) c from poc group by category order by c desc")
    for r in cur.fetchall():
        print(f"  {r['category'] or '(空)':<18} {r['c']}")
    print("\n按来源:")
    cur.execute("select source, count(*) c from poc group by source order by c desc")
    for r in cur.fetchall():
        print(f"  {r['source'] or '(空)':<18} {r['c']}")
    con.close()


def cmd_add(args):
    con = connect()
    cur = con.cursor()
    with open(args.file, encoding="utf-8") as f:
        d = json.load(f)
    if isinstance(d, list):
        items = d
    else:
        items = [d]
    n = 0
    for d in items:
        if not d.get("title"):
            print("[!] 跳过无 title 的条目")
            continue
        code = d.get("code") or (d["title"].lower().replace(" ", "-")[:60] +
                                 "-" + datetime.now().strftime("%y%m%d%H%M"))
        now = datetime.now().isoformat()
        cur.execute("select id from poc where code = ?", (code,))
        exists = cur.fetchone()
        data = (
            code, d["title"], d.get("kind"), d.get("category"), d.get("cve"),
            d.get("component"), d.get("versions"), d.get("severity"), d.get("language"),
            d.get("source"), d.get("source_url"), d.get("description"), d.get("usage"),
            d.get("content"), d.get("path"), 1 if d.get("verified") else 0,
            d.get("verified_note"), d.get("engagement_name"), d.get("asset_target"),
            d.get("found_by_agent"), d.get("tags"), d.get("created_by") or "kb.py", now, now,
        )
        if exists:
            cur.execute("""update poc set title=?,kind=?,category=?,cve=?,component=?,
                versions=?,severity=?,language=?,source=?,source_url=?,description=?,
                usage=?,content=?,path=?,verified=?,verified_note=?,engagement_name=?,
                asset_target=?,found_by_agent=?,tags=?,created_by=?,updated_at=?
                where code=?""",
                data[1:22] + (code,))
            print(f"[~] 更新: {code}")
        else:
            cur.execute("""insert into poc
                (code,title,kind,category,cve,component,versions,severity,language,
                 source,source_url,description,usage,content,path,verified,
                 verified_note,engagement_name,asset_target,found_by_agent,tags,
                 created_by,created_at,updated_at)
                values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""", data)
            print(f"[+] 新增: {code}")
        n += 1
    con.commit()
    print(f"\n完成 {n} 条")
    con.close()


def cmd_export(args):
    out = args.dir
    os.makedirs(out, exist_ok=True)
    con = connect()
    cur = con.cursor()
    cur.execute("select * from poc order by category, id")
    rows = cur.fetchall()
    lines = ["# POC 知识库导出\n", f"共 {len(rows)} 条 · 导出时间 {datetime.now():%Y-%m-%d %H:%M}\n"]
    index = ["## 索引\n", "| id | 标题 | 归类 | CVE | 验证 |", "| --- | --- | --- | --- | --- |"]
    for r in rows:
        index.append(f"| {r['id']} | {r['title']} | {r['category'] or ''} | {r['cve'] or ''} | {'Y' if r['verified'] else '-'} |")
    lines += index
    lines.append("\n---\n")
    for r in rows:
        lines.append(f"## [{r['id']}] {r['title']}\n")
        for k in ("code", "kind", "category", "cve", "component", "versions",
                  "severity", "language", "source", "source_url", "verified", "tags"):
            if r[k] not in (None, ""):
                lines.append(f"- **{k}**: {r[k]}")
        lines.append("")
        if r["description"]:
            lines.append(f"**描述**：{r['description']}\n")
        if r["usage"]:
            lines.append(f"**用法**：\n```\n{r['usage']}\n```\n")
        if r["content"]:
            lines.append(f"**正文**：\n```\n{r['content']}\n```\n")
        lines.append("---\n")
    p = os.path.join(out, "POC-INDEX.md")
    with open(p, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    print(f"已导出: {p}  ({len(rows)} 条)")
    con.close()


def main():
    ap = argparse.ArgumentParser(description="本地 POC 知识库 CLI")
    sub = ap.add_subparsers(dest="cmd")

    sub.add_parser("list", help="列出全部").set_defaults(func=cmd_list)

    p = sub.add_parser("search", help="全文搜索")
    p.add_argument("keyword", nargs="+")
    p.set_defaults(func=cmd_search)

    p = sub.add_parser("get", help="取全文")
    p.add_argument("key", help="id 或 code")
    p.set_defaults(func=cmd_get)

    p = sub.add_parser("cat", help="按归类筛")
    p.add_argument("category")
    p.set_defaults(func=cmd_cat)

    sub.add_parser("stats", help="统计").set_defaults(func=cmd_stats)

    p = sub.add_parser("add", help="新增/更新")
    p.add_argument("--file", required=True)
    p.set_defaults(func=cmd_add)

    p = sub.add_parser("export", help="导出 Markdown")
    p.add_argument("dir")
    p.set_defaults(func=cmd_export)

    args = ap.parse_args()
    if not getattr(args, "func", None):
        ap.print_help()
        return
    args.func(args)


if __name__ == "__main__":
    main()
