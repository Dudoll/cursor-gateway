#!/usr/bin/env python3
"""Render and optionally publish approved Xiaohongshu interview-post drafts.

Manual mode is the safe default: it writes a caption, JSON payload, and SVG
cards to a private outbox. Official mode calls a user-provided, documented
partner endpoint. This module deliberately does not automate consumer login or
reverse-engineer private Xiaohongshu APIs.
"""

from __future__ import annotations

import argparse
import html
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


def request_json(method: str, path: str, payload: dict[str, Any] | None = None) -> dict[str, Any] | None:
    base_url = os.environ.get("CURSOR_GATEWAY_INTERNAL_URL", "http://127.0.0.1:18080").rstrip("/")
    secret = os.environ.get("CURSOR_GATEWAY_AUTOMATION_SECRET", "")
    if len(secret) < 32:
        raise RuntimeError("CURSOR_GATEWAY_AUTOMATION_SECRET is not configured")
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    request = urllib.request.Request(
        f"{base_url}{path}",
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {secret}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            if response.status == 204:
                return None
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:1_000]
        raise RuntimeError(f"Gateway HTTP {exc.code}: {detail}") from exc


def wrap_text(text: str, width: int, max_lines: int) -> list[str]:
    compact = " ".join(text.replace("\r", "").split())
    lines: list[str] = []
    while compact and len(lines) < max_lines:
        lines.append(compact[:width])
        compact = compact[width:]
    if compact and lines:
        lines[-1] = lines[-1][:-1] + "…"
    return lines


def render_svg(card: dict[str, Any], index: int, total: int) -> str:
    title_lines = wrap_text(str(card.get("title") or "每日面经"), 16, 3)
    body_lines = wrap_text(str(card.get("body") or ""), 28, 16)
    title = "".join(
        f'<text x="92" y="{360 + line * 92}" class="title">{html.escape(value)}</text>'
        for line, value in enumerate(title_lines)
    )
    body_start = 360 + len(title_lines) * 92 + 74
    body = "".join(
        f'<text x="92" y="{body_start + line * 52}" class="body">{html.escape(value)}</text>'
        for line, value in enumerate(body_lines)
    )
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1440" viewBox="0 0 1080 1440">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#101714"/><stop offset="1" stop-color="#080b0a"/></linearGradient>
    <radialGradient id="glow"><stop stop-color="#3eb982" stop-opacity=".28"/><stop offset="1" stop-color="#3eb982" stop-opacity="0"/></radialGradient>
    <style>
      text {{ font-family: Inter, "Noto Sans SC", "Microsoft YaHei", sans-serif; }}
      .kicker {{ fill:#55d99a; font-size:25px; font-weight:700; letter-spacing:4px; }}
      .title {{ fill:#f3f7f5; font-size:70px; font-weight:760; }}
      .body {{ fill:#bdc9c3; font-size:34px; font-weight:440; }}
      .footer {{ fill:#7d8d85; font-size:24px; }}
    </style>
  </defs>
  <rect width="1080" height="1440" fill="url(#bg)"/>
  <circle cx="940" cy="90" r="460" fill="url(#glow)"/>
  <path d="M56 118V56h62M962 1384h62v-62" fill="none" stroke="#3eb982" stroke-opacity=".55" stroke-width="4"/>
  <text x="92" y="170" class="kicker">{html.escape(str(card.get("kicker") or "DAILY INTERVIEW"))}</text>
  {title}
  {body}
  <text x="92" y="1330" class="footer">{html.escape(str(card.get("footer") or "完整内容见主页"))}</text>
  <text x="930" y="1330" class="footer">{index:02d}/{total:02d}</text>
</svg>'''


def render_png(card: dict[str, Any], index: int, total: int, path: Path) -> bool:
    try:
        from PIL import Image, ImageDraw, ImageFont
    except ImportError:
        return False
    font_path = os.environ.get("XHS_FONT_PATH", "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc")
    if not Path(font_path).is_file():
        raise RuntimeError("set XHS_FONT_PATH to a Chinese-capable TTF/TTC font")
    image = Image.new("RGB", (1080, 1440), "#0b100e")
    draw = ImageDraw.Draw(image)
    draw.ellipse((720, -220, 1340, 400), fill="#173d2d")
    kicker_font = ImageFont.truetype(font_path, 28)
    title_font = ImageFont.truetype(font_path, 70)
    body_font = ImageFont.truetype(font_path, 36)
    footer_font = ImageFont.truetype(font_path, 25)
    draw.line((56, 118, 56, 56, 118, 56), fill="#3eb982", width=4)
    draw.line((962, 1384, 1024, 1384, 1024, 1322), fill="#3eb982", width=4)
    draw.text((92, 142), str(card.get("kicker") or "DAILY INTERVIEW"), font=kicker_font, fill="#55d99a")
    y = 330
    for line in wrap_text(str(card.get("title") or "每日面经"), 14, 3):
        draw.text((92, y), line, font=title_font, fill="#f3f7f5")
        y += 94
    y += 48
    for line in wrap_text(str(card.get("body") or ""), 25, 16):
        draw.text((92, y), line, font=body_font, fill="#bdc9c3")
        y += 54
    draw.text((92, 1300), str(card.get("footer") or "完整内容见主页"), font=footer_font, fill="#7d8d85")
    draw.text((930, 1300), f"{index:02d}/{total:02d}", font=footer_font, fill="#7d8d85")
    image.save(path, format="PNG", optimize=True)
    return True


def export_manual(publication: dict[str, Any]) -> Path:
    root = Path(os.environ.get("XHS_OUTBOX_DIR", Path.home() / ".hermes" / "xhs-outbox"))
    target = root / str(publication["id"])
    target.mkdir(mode=0o700, parents=True, exist_ok=True)
    (target / "caption.md").write_text(
        f"# {publication['title']}\n\n{publication['body']}\n",
        encoding="utf-8",
    )
    (target / "post.json").write_text(
        json.dumps(publication, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    cards = publication.get("assets") or []
    for index, card in enumerate(cards, start=1):
        (target / f"card-{index:02d}.svg").write_text(
            render_svg(card, index, len(cards)),
            encoding="utf-8",
        )
        if not render_png(card, index, len(cards), target / f"card-{index:02d}.png"):
            print("Pillow is not installed; exported SVG cards only.", file=sys.stderr)
    return target


def publish_official(publication: dict[str, Any]) -> str:
    endpoint = os.environ.get("XHS_OFFICIAL_PUBLISH_URL", "").strip()
    token = os.environ.get("XHS_OFFICIAL_ACCESS_TOKEN", "").strip()
    if not endpoint or not token:
        raise RuntimeError("official mode requires XHS_OFFICIAL_PUBLISH_URL and XHS_OFFICIAL_ACCESS_TOKEN")
    request = urllib.request.Request(
        endpoint,
        data=json.dumps(publication, ensure_ascii=False).encode("utf-8"),
        method="POST",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=90) as response:
        result = json.loads(response.read().decode("utf-8"))
    post_id = result.get("post_id") or result.get("id")
    if not post_id:
        raise RuntimeError("official adapter response did not include post_id or id")
    return str(post_id)


def run_once(mode: str) -> int:
    claimed = request_json("POST", "/api/automation/social/xiaohongshu/claim")
    if not claimed:
        print("No approved Xiaohongshu publication is waiting.", file=sys.stderr)
        return 0
    publication = claimed["publication"]
    publication_id = publication["id"]
    try:
        if mode == "manual":
            target = export_manual(publication)
            request_json(
                "POST",
                f"/api/automation/social/xiaohongshu/publications/{publication_id}/result",
                {"status": "exported", "externalPostId": None, "error": None},
            )
            print(f"Exported Xiaohongshu package: {target}")
        else:
            post_id = publish_official(publication)
            request_json(
                "POST",
                f"/api/automation/social/xiaohongshu/publications/{publication_id}/result",
                {"status": "published", "externalPostId": post_id, "error": None},
            )
            print(f"Published Xiaohongshu post: {post_id}")
        return 0
    except Exception as exc:
        request_json(
            "POST",
            f"/api/automation/social/xiaohongshu/publications/{publication_id}/result",
            {"status": "failed", "externalPostId": None, "error": str(exc)[:2_000]},
        )
        raise


def main() -> int:
    parser = argparse.ArgumentParser(description="Process one approved Xiaohongshu publication")
    parser.add_argument(
        "--mode",
        choices=("manual", "official"),
        default=os.environ.get("XHS_PUBLISH_MODE", "manual"),
    )
    args = parser.parse_args()
    return run_once(args.mode)


if __name__ == "__main__":
    raise SystemExit(main())
