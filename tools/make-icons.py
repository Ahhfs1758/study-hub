#!/usr/bin/env python3
"""生成应用图标与菜单栏图标（零依赖，纯标准库）。

为什么不用现成的图片：Electron 需要一个 512 的 app icon、一个 macOS 菜单栏用的
template 图标（必须纯黑 + alpha，系统会自行反色）、一个 Windows 托盘用的彩色图标。
这三者形状一致、配色不同，用代码生成比维护三份二进制素材更不容易出错。

做法：定义几个基于连续坐标的「形状谓词」，每个子像素采样一次再降采样，
自带抗锯齿；形状用简单的 over 合成叠加。
"""
import math
import os
import struct
import zlib

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets')
SS = 4  # 每像素 4×4 超采样

BLUE = (0x3b, 0x5b, 0xfd)
PURPLE = (0x6d, 0x5c, 0xf6)
WHITE = (0xff, 0xff, 0xff)


# --------------------------------------------------------------------------
# PNG 编码
# --------------------------------------------------------------------------
def write_png(path, w, h, rgba):
    raw = b''.join(b'\x00' + bytes(rgba[y * w * 4:(y + 1) * w * 4]) for y in range(h))

    def chunk(tag, data):
        return (struct.pack('>I', len(data)) + tag + data
                + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff))

    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(raw, 9))
    png += chunk(b'IEND', b'')
    with open(path, 'wb') as f:
        f.write(png)


# --------------------------------------------------------------------------
# 基础图元
# --------------------------------------------------------------------------
def over(dst, src):
    """src over dst，均为 (r,g,b,a) 且 r,g,b 是 0-1。"""
    sr, sg, sb, sa = src
    dr, dg, db, da = dst
    oa = sa + da * (1 - sa)
    if oa <= 0:
        return (0.0, 0.0, 0.0, 0.0)
    return (
        (sr * sa + dr * da * (1 - sa)) / oa,
        (sg * sa + dg * da * (1 - sa)) / oa,
        (sb * sa + db * da * (1 - sa)) / oa,
        oa,
    )


def sd_round_rect(px, py, x, y, w, h, r):
    """圆角矩形的有符号距离，<0 表示在内部。"""
    cx, cy = x + w / 2, y + h / 2
    dx, dy = abs(px - cx) - (w / 2 - r), abs(py - cy) - (h / 2 - r)
    ax, ay = max(dx, 0), max(dy, 0)
    return math.hypot(ax, ay) + min(max(dx, dy), 0) - r


def sd_segment(px, py, ax, ay, bx, by):
    vx, vy = bx - ax, by - ay
    wx, wy = px - ax, py - ay
    L2 = vx * vx + vy * vy
    t = 0 if L2 == 0 else max(0, min(1, (wx * vx + wy * vy) / L2))
    return math.hypot(wx - vx * t, wy - vy * t)


def cov(sd, aa=1.0):
    """距离场 → 覆盖率，边缘 1px 抗锯齿。"""
    return max(0.0, min(1.0, 0.5 - sd / aa))


def in_quad(px, py, pts):
    """点是否在凸多边形内（用于书页）。"""
    sign = 0
    n = len(pts)
    for i in range(n):
        ax, ay = pts[i]
        bx, by = pts[(i + 1) % n]
        cross = (bx - ax) * (py - ay) - (by - ay) * (px - ax)
        if abs(cross) < 1e-9:
            continue
        s = 1 if cross > 0 else -1
        if sign == 0:
            sign = s
        elif s != sign:
            return False
    return True


def quad_cov(px, py, pts, aa=1.0):
    """多边形覆盖率（内部 1，外部按到最近边的距离做 1px 抗锯齿）。"""
    if in_quad(px, py, pts):
        return 1.0
    d = min(sd_segment(px, py, pts[i][0], pts[i][1], pts[(i + 1) % len(pts)][0], pts[(i + 1) % len(pts)][1])
            for i in range(len(pts)))
    return max(0.0, min(1.0, 0.5 - d / aa))


# --------------------------------------------------------------------------
# 打开的书（用归一化坐标定义，随尺寸缩放）
# --------------------------------------------------------------------------
def book_pages(u, v):
    """返回 (左页覆盖率, 右页覆盖率)。u,v ∈ [0,1]

    形状是一本摊开的书：书脊在中央且位置最低（V 形内凹），两侧书页向上翘起。
    """
    left = [
        (0.142, 0.268), (0.478, 0.352), (0.478, 0.742), (0.142, 0.658),
    ]
    right = [
        (0.522, 0.352), (0.858, 0.268), (0.858, 0.658), (0.522, 0.742),
    ]
    return quad_cov(u, v, left), quad_cov(u, v, right)


def book_alpha(u, v, aa):
    """整本书的 alpha。

    两页之间本来就留了 0.478~0.522 的空隙来表现书脊，所以这里不再额外画中缝线 ——
    早先版本加了一条竖线，在图标尺寸下会看成「书里插了根筷子」。
    """
    l, r = book_pages(u, v)
    return max(l, r)


def make_book_layer(color, scale, offset=(0, 0), aa=1.0):
    """把书形书在画布上的图层函数：入参为画布像素坐标，返回 (r,g,b,a) 或 None。

    注意 color 用 0-255 的整数传入，这里统一归一化 —— 之前在调用处漏了这一步，
    导致白色被当成 1.0 直接铺满整张图（图标渲染成一片白）。
    """
    cr, cg, cb = color[0] / 255, color[1] / 255, color[2] / 255

    def layer(x, y):
        u = (x - offset[0]) / scale
        v = (y - offset[1]) / scale
        if u < 0 or u > 1 or v < 0 or v > 1:
            return None
        a = book_alpha(u, v, aa / scale)
        if a <= 0:
            return None
        return (cr, cg, cb, a)
    return layer


# --------------------------------------------------------------------------
# 渲染
# --------------------------------------------------------------------------
def render(w, h, shade):
    buf = bytearray(w * h * 4)
    inv = 1.0 / (SS * SS)
    for py in range(h):
        for px in range(w):
            ar = ag = ab = aa_ = 0.0
            for sy in range(SS):
                for sx in range(SS):
                    x = px + (sx + 0.5) / SS
                    y = py + (sy + 0.5) / SS
                    r, g, b, a = shade(x, y)
                    ar += r * a
                    ag += g * a
                    ab += b * a
                    aa_ += a
            a = aa_ * inv
            if aa_ > 1e-6:
                r, g, b = ar / aa_, ag / aa_, ab / aa_
            else:
                r = g = b = 0.0
            i = (py * w + px) * 4
            buf[i] = int(round(max(0, min(1, r)) * 255))
            buf[i + 1] = int(round(max(0, min(1, g)) * 255))
            buf[i + 2] = int(round(max(0, min(1, b)) * 255))
            buf[i + 3] = int(round(max(0, min(1, a)) * 255))
    return buf


def app_icon(size):
    """应用图标：渐变圆角方块 + 白色打开的书"""
    radius = size * 0.225
    scale = size
    book = make_book_layer(WHITE, scale, (0, 0), aa=1.0)

    def shade(x, y):
        d = sd_round_rect(x, y, 0, 0, size, size, radius)
        a = cov(d, 1.0)
        if a <= 0:
            return (0, 0, 0, 0)
        # 135° 对角渐变
        t = max(0.0, min(1.0, (x + y) / (2 * size)))
        base = tuple(BLUE[i] / 255 + (PURPLE[i] - BLUE[i]) / 255 * t for i in range(3))
        out = (base[0], base[1], base[2], a)
        g = book(x, y)
        if g:
            out = over(out, g)
        return out

    return render(size, size, shade)


def tray_icon(size, color, aa=1.0):
    """菜单栏 / 托盘图标：纯书形，无背景"""
    scale = size * 0.98
    off = (size * 0.01, size * 0.01)
    book = make_book_layer(color, scale, off, aa=aa)

    def shade(x, y):
        g = book(x, y)
        return g if g else (0, 0, 0, 0)

    return render(size, size, shade)


ACCENT = (0x3b, 0x5b, 0xfd)
BLACK = (0, 0, 0)


def main():
    os.makedirs(OUT, exist_ok=True)

    jobs = [
        ('icon.png', 512, lambda s: app_icon(s)),
        ('icon-256.png', 256, lambda s: app_icon(s)),
        ('tray.png', 32, lambda s: tray_icon(s, ACCENT, aa=0.9)),
        ('tray@2x.png', 64, lambda s: tray_icon(s, ACCENT, aa=0.9)),
        # macOS 菜单栏用 template：纯黑 + alpha，系统会随明暗自动反色
        ('trayTemplate.png', 22, lambda s: tray_icon(s, BLACK, aa=0.85)),
        ('trayTemplate@2x.png', 44, lambda s: tray_icon(s, BLACK, aa=0.85)),
    ]
    for name, size, fn in jobs:
        write_png(os.path.join(OUT, name), size, size, fn(size))
        print('wrote %-24s %dx%d' % (name, size, size))


if __name__ == '__main__':
    main()
