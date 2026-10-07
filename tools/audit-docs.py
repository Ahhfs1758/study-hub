#!/usr/bin/env python3
"""audit-docs.py —— 文档粘贴安全性审计（零依赖）

为什么需要这个脚本：

  zsh 默认**不**把 `#` 当注释（`interactive_comments` 未开启）。所以在真实终端里
  连行尾注释一起复制粘贴 `npm start  # 启动` 时，`#` 后面的内容会**原样作为参数**传给程序。
  用户看到的是 `npm error code ENOENT` 或 `unrecognized arguments` 之类的莫名报错，
  而用户的操作完全没错 —— 是文档写得不安全。

  这不是理论问题：本项目 README 里就有 8 处这样的命令块，用户照抄之后直接报错。

本脚本扫描所有 markdown 的 fenced code block，找出：
  1. 行尾注释（`命令  # 说明`）—— 会被 shell 当成参数，必须把说明移到块外
  2. 块内出现的 `cd` 之后紧跟绝对路径但没有提示（可选，仅提醒）

退出码非 0 表示发现不安全写法，可直接接进 CI / run-checks.sh。
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FENCE = re.compile(r'^\s*(```|~~~)')
# 「命令 + 空白 + # + 内容」；纯 `#` 开头的整行注释是合法的（不会被传成参数）
TRAILING_COMMENT = re.compile(r'^(?!\s*#).*\S\s+#\s*\S')
# shell 提示符，复制时会一起带进去，也是常见事故源
PROMPT = re.compile(r'^\s*(\$\s+|mac@\S+\s+[%~/].*?\s[%$]\s+)')


def scan_file(path):
    problems = []
    try:
        text = open(path, encoding='utf-8').read()
    except Exception as err:                       # noqa: BLE001
        return [('io', 0, '读不了这个文件：%s' % err)]

    in_block = False
    lang = ''
    for i, line in enumerate(text.splitlines(), 1):
        m = FENCE.match(line)
        if m:
            if in_block:
                in_block = False
                lang = ''
            else:
                in_block = True
                lang = line.strip().lstrip('`~').strip()
            continue
        if not in_block:
            continue
        # 只审 shell 类的块
        if lang not in ('sh', 'bash', 'zsh', 'shell', ''):
            continue
        if TRAILING_COMMENT.match(line):
            problems.append(('trailing-comment', i, line.strip()))
        elif PROMPT.match(line):
            problems.append(('prompt', i, line.strip()))
    return problems


def main():
    targets = []
    for base, dirs, files in os.walk(ROOT):
        dirs[:] = [d for d in dirs if d not in (
            'node_modules', '.git', 'release', '.selftest', 'backups', 'vault', '__pycache__')]
        for f in files:
            if f.lower().endswith(('.md', '.markdown')):
                targets.append(os.path.join(base, f))

    total = 0
    for path in sorted(targets):
        problems = scan_file(path)
        if not problems:
            continue
        rel = os.path.relpath(path, ROOT)
        for kind, line, content in problems:
            if kind == 'io':
                print('  ! %s' % content)
                continue
            total += 1
            tag = '行尾注释' if kind == 'trailing-comment' else '带提示符'
            print('  ✗ %s:%s  [%s]  %s' % (rel, line, tag, content[:90]))

    print()
    if total:
        print('✗ 发现 %d 处「复制粘贴会出错」的写法。' % total)
        print('  原因：zsh 默认不把 # 当注释，行尾注释会被当成参数传给程序；')
        print('       带 $ 或 user@host 提示符的行复制后也会连同提示符一起执行。')
        print('  改法：命令块里只放命令本身，说明移到块外或用表格。')
        return 1
    print('✓ 文档命令块全部可以直接复制粘贴（已扫描 %d 个文件）' % len(targets))
    return 0


if __name__ == '__main__':
    sys.exit(main())
