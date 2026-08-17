#!/usr/bin/env python3
"""生成喵迹 PWA 图标（192 / 512 / apple-touch-icon 180）"""
from PIL import Image, ImageDraw
import os

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'dist')
BG = (247, 243, 236)      # 米白底
ACCENT = (214, 138, 92)   # 暖橙
DARK = (61, 55, 47)


def make(size):
    img = Image.new('RGB', (size, size), ACCENT)
    d = ImageDraw.Draw(img)
    s = size / 512.0

    # 圆角底色块
    pad = int(48 * s)
    d.rounded_rectangle([pad, pad, size - pad, size - pad],
                        radius=int(96 * s), fill=BG)

    cx, cy = size / 2, size / 2 + 14 * s
    r = 118 * s

    # 猫脸
    d.ellipse([cx - r, cy - r * 0.92, cx + r, cy + r * 0.92], fill=ACCENT)
    # 耳朵
    ear = 62 * s
    d.polygon([(cx - r * 0.82, cy - r * 0.52), (cx - r * 0.60, cy - r * 1.30),
               (cx - r * 0.16, cy - r * 0.80)], fill=ACCENT)
    d.polygon([(cx + r * 0.82, cy - r * 0.52), (cx + r * 0.60, cy - r * 1.30),
               (cx + r * 0.16, cy - r * 0.80)], fill=ACCENT)
    # 眼睛
    eye = 15 * s
    d.ellipse([cx - 48 * s - eye, cy - 18 * s - eye, cx - 48 * s + eye, cy - 18 * s + eye], fill=BG)
    d.ellipse([cx + 48 * s - eye, cy - 18 * s - eye, cx + 48 * s + eye, cy - 18 * s + eye], fill=BG)
    # 鼻子
    d.polygon([(cx - 13 * s, cy + 24 * s), (cx + 13 * s, cy + 24 * s), (cx, cy + 40 * s)], fill=BG)

    # 底部成长曲线（呼应"记录/成长"）
    w = max(2, int(9 * s))
    pts = [(cx - 92 * s, cy + 96 * s), (cx - 40 * s, cy + 74 * s),
           (cx + 8 * s, cy + 88 * s), (cx + 92 * s, cy + 46 * s)]
    d.line(pts, fill=DARK, width=w, joint='curve')
    for p in pts:
        rr = w * 0.9
        d.ellipse([p[0] - rr, p[1] - rr, p[0] + rr, p[1] + rr], fill=DARK)

    return img


os.makedirs(OUT, exist_ok=True)
for sz, name in [(192, 'icon-192.png'), (512, 'icon-512.png'), (180, 'apple-touch-icon.png')]:
    make(sz).save(os.path.join(OUT, name), 'PNG', optimize=True)
    print('generated', name)
