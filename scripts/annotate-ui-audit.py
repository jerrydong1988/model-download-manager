"""生成 UI 审计标注图：在现有截图上标注问题编号，并附加图例。"""
from __future__ import annotations

import os
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.join(ROOT, "docs", "screenshots")
FONT_PATH = r"C:\Windows\Fonts\msyh.ttc"

RED = (220, 38, 38)
RED_SOFT = (254, 226, 226)
WHITE = (255, 255, 255)
INK = (15, 23, 42)
MUTED = (71, 85, 105)

ANNOTATIONS = {
    "02-downloads": {
        "source": "02-downloads.png",
        "output": "audit-annotated-downloads.png",
        "markers": [
            ((300, 167), "1"),
            ((560, 315), "2"),
            ((1231, 293), "3"),
            ((700, 332), "4"),
            ((320, 227), "5"),
            ((1140, 400), "6"),
            ((37, 84), "7"),
        ],
        "legend": [
            ("1", "统计卡辅助文字 12px + text-slate-400：对比度 2.56:1（AA 要求 4.5:1）"),
            ("2", "任务次要信息（仓库/路径）11px + slate-400，可读性与对比度不足"),
            ("3", "行内操作按钮 32×32（h-8/w-8），桌面鼠标目标偏小、图标间距紧"),
            ("4", "进度条仅 6px 高（h-1.5），远距离扫视时进度不易读取"),
            ("5", "筛选/工具控件 28–32px 高，与表格 44px 行高形成密度断层"),
            ("6", "汇总行 11px + slate-400：低对比度小字（WCAG AA 不达标）"),
            ("7", "侧栏分组标题 11px + slate-400：低对比度小字"),
        ],
    },
    "03-library": {
        "source": "03-library.png",
        "output": "audit-annotated-library.png",
        "markers": [
            ((300, 168), "1"),
            ((480, 230), "2"),
            ((700, 315), "3"),
            ((1090, 349), "4"),
            ((1237, 349), "5"),
            ((37, 84), "6"),
            ((900, 313), "7"),
        ],
        "legend": [
            ("1", "统计卡 hint 12px + slate-400（对比度 2.56:1）"),
            ("2", "筛选 chips 高度 28px + 计数 10px：小字与密集控件"),
            ("3", "表头 11px + slate-500（对比度 4.76:1 达标，但字号低于 12px）"),
            ("4", "大小/修改时间 11px + slate-400：数据列可读性不足"),
            ("5", "行内操作按钮 32×32，且同一行两个图标目标间距 2px"),
            ("6", "侧栏分组标题 11px + slate-400"),
            ("7", "根节点「下载目录」徽章 11px：层级标识偏弱"),
        ],
    },
    "04-settings": {
        "source": "04-settings.png",
        "output": "audit-annotated-settings.png",
        "markers": [
            ((340, 254), "1"),
            ((240, 570), "2"),
            ((1050, 810), "3"),
            ((1240, 386), "4"),
            ((800, 690), "5"),
        ],
        "legend": [
            ("1", "提示文字 11px + slate-400 且与输入框间距小，长说明可读性差"),
            ("2", "卡片高度大、信息密度低：一屏只能看到 2 个分组"),
            ("3", "底部 sticky 保存条覆盖内容（860px 高时遮住最后一组设置）"),
            ("4", "「可选」标签 11px + slate-400：低对比度"),
            ("5", "数字步进器按钮 32×32，与 36px 输入框高度不齐"),
        ],
    },
}


def font(size: int) -> ImageFont.FreeTypeFont:
    try:
        return ImageFont.truetype(FONT_PATH, size)
    except OSError:
        return ImageFont.load_default()


def wrap_text(draw: ImageDraw.ImageDraw, text: str, fnt: ImageFont.FreeTypeFont, max_width: int) -> list[str]:
    # CJK-aware greedy wrap
    lines: list[str] = []
    current = ""
    for ch in text:
        trial = current + ch
        if draw.textlength(trial, font=fnt) <= max_width:
            current = trial
        else:
            if current:
                lines.append(current)
            current = ch
    if current:
        lines.append(current)
    return lines


def annotate(cfg: dict) -> None:
    src = os.path.join(SHOTS, cfg["source"])
    image = Image.open(src).convert("RGBA")
    width, height = image.size
    draw = ImageDraw.Draw(image)

    r = 14
    for (x, y), label in cfg["markers"]:
        draw.ellipse((x - r - 4, y - r - 4, x + r + 4, y + r + 4), fill=(*RED, 60))
        draw.ellipse((x - r, y - r, x + r, y + r), fill=(*RED, 235), outline=WHITE, width=2)
        fnt = font(16)
        bbox = draw.textbbox((0, 0), label, font=fnt)
        tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
        draw.text((x - tw / 2, y - th / 2 - 1), label, font=fnt, fill=WHITE)

    legend_font = font(19)
    title_font = font(22)
    pad = 28
    line_h = 34
    legend_h = pad + 40 + line_h * len(cfg["legend"]) + pad

    canvas = Image.new("RGBA", (width, height + legend_h), (255, 255, 255, 255))
    canvas.paste(image, (0, 0))
    cdraw = ImageDraw.Draw(canvas)
    cdraw.line((0, height, width, height), fill=(226, 232, 240, 255), width=1)
    cdraw.text((pad, height + 14), "UI 审计标注（问题编号对应 docs/UI-AUDIT.md 问题清单）", font=title_font, fill=INK)

    y = height + 14 + 34
    for num, text in cfg["legend"]:
        cx, cy = pad + 11, y + 12
        cdraw.ellipse((cx - 11, cy - 11, cx + 11, cy + 11), fill=(*RED, 255))
        bbox = cdraw.textbbox((0, 0), num, font=font(14))
        cdraw.text((cx - (bbox[2] - bbox[0]) / 2, cy - (bbox[3] - bbox[1]) / 2 - 1), num, font=font(14), fill=WHITE)
        clipped = wrap_text(cdraw, text, legend_font, width - pad * 2 - 40)
        cdraw.text((pad + 34, y + 1), clipped[0] if clipped else text, font=legend_font, fill=MUTED)
        y += line_h

    out = os.path.join(SHOTS, cfg["output"])
    canvas.convert("RGB").save(out, quality=92)
    print("saved", out, canvas.size)


def main() -> None:
    for cfg in ANNOTATIONS.values():
        annotate(cfg)


if __name__ == "__main__":
    main()
