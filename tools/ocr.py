#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
图片文字识别（零下载，调用 Windows 自带 OCR）。
用法：
  python tools/ocr.py 图片路径              # 打印 JSON
  （服务端通过 /api/ocr 调用）
输出：[{"text": "...", "x": .., "y": .., "w": .., "h": ..}] 坐标是原图坐标
"""
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PS1 = ROOT / 'tools' / 'ocr.ps1'
POWERSHELL = os.path.join(os.environ.get('SystemRoot', r'C:\Windows'),
                          'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

CJK = r'\u3400-\u9fff\u3000-\u303f\uff00-\uffef'


def _strip_cjk_spaces(text):
    """OCR 会把中文逐字加空格："黑 兽 加" -> "黑鲁加"。"""
    text = text.strip()
    text = re.sub(r'(?<=[%s])\s+(?=[%s])' % (CJK, CJK), '', text)
    text = re.sub(r'\s{2,}', ' ', text)
    return text


def _variants(img):
    """准备几种预处理版本，识别效果取最好的那种。"""
    from PIL import Image, ImageOps

    gray = img.convert('L')
    out = []

    a = ImageOps.autocontrast(gray)
    out.append(('plain', a))

    # 游戏里的字是浅色带描边，压在深色背景上：拉高对比、稍微加粗
    b = ImageOps.autocontrast(gray, cutoff=1)
    b = b.point(lambda v: 255 if v > 90 else (0 if v < 45 else v))
    out.append(('contrast', b))

    return out


def _run_ps1(path):
    try:
        r = subprocess.run([POWERSHELL, '-NoProfile', '-ExecutionPolicy', 'Bypass',
                            '-File', str(PS1), '-Path', str(path)],
                           capture_output=True, timeout=180)
    except Exception:
        return []
    raw = r.stdout.decode('utf-8', 'replace').strip()
    if not raw:
        return []
    try:
        data = json.loads(raw)
    except Exception:
        return []
    if isinstance(data, dict):
        data = [data]
    return data


def recognize(path, scale=1.5, max_side=4200):
    from PIL import Image

    img = Image.open(path)
    img.load()
    w, h = img.size
    if max(w, h) * scale > max_side:
        scale = max(1.0, max_side / max(w, h))

    best = []
    for name, variant in _variants(img):
        sw, sh = int(variant.width * scale), int(variant.height * scale)
        up = variant.resize((sw, sh), Image.LANCZOS)
        tmp = Path(tempfile.gettempdir()) / ('pa_ocr_%s.png' % name)
        up.save(tmp)
        lines = _run_ps1(tmp)
        for ln in lines:
            ln['x'] = int(round(ln.get('x', 0) / scale))
            ln['y'] = int(round(ln.get('y', 0) / scale))
            ln['w'] = int(round(ln.get('w', 0) / scale))
            ln['h'] = int(round(ln.get('h', 0) / scale))
            ln['text'] = _strip_cjk_spaces(str(ln.get('text', '')))
        if len(lines) > len(best):
            best = lines
        try:
            tmp.unlink()
        except OSError:
            pass
    return best


def main():
    if len(sys.argv) < 2:
        print('用法: python tools/ocr.py <图片> [输出json]')
        return 1
    lines = recognize(sys.argv[1])
    payload = json.dumps(lines, ensure_ascii=False)
    if len(sys.argv) > 2:
        with open(sys.argv[2], 'w', encoding='utf-8') as f:
            f.write(payload)
    else:
        print(payload)
    return 0


if __name__ == '__main__':
    sys.exit(main())
