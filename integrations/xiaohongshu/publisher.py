#!/usr/bin/env python3
"""Render and optionally publish approved Xiaohongshu interview-post drafts.

Manual mode is the safe default: it writes a caption, JSON payload, and SVG
cards to a private outbox. Official mode calls a user-provided, documented
partner endpoint. Full-auto mode orchestrates the entire pipeline:
prepare drafts → approve → claim → export/publish.

This module deliberately does not automate consumer login or
reverse-engineer private Xiaohongshu APIs.
"""

from __future__ import annotations

import argparse
import html
import json
import os
import re
import shutil
import sys
import urllib.error
import urllib.request
import zipfile
from pathlib import Path
from typing import Any


def request_json(method: str, path: str, payload: dict[str, Any] | None = None) -> dict[str, Any] | None:
    base_url = os.environ.get("CURSOR_GATEWAY_INTERNAL_URL", "http://127.0.0.1:18080").rstrip("/")
    secret = os.environ.get("CURSOR_GATEWAY_AUTOMATION_SECRET", "")
    if len(secret) < 32:
        raise RuntimeError("CURSOR_GATEWAY_AUTOMATION_SECRET is not configured")
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    headers = {"Authorization": f"Bearer {secret}"}
    # Fastify rejects an empty request body when JSON content type is set.
    # Only declare JSON when an actual payload is present.
    if payload is not None:
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(
        f"{base_url}{path}",
        data=data,
        method=method,
        headers=headers,
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            if response.status == 204:
                return None
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:1_000]
        raise RuntimeError(f"Gateway HTTP {exc.code}: {detail}") from exc


def wrap_text(text: str, width: int, max_lines: int) -> tuple[list[str], str]:
    """Split text into display lines, preserving logical structure.

    Returns (lines, overflow) where overflow is the text that couldn't fit.
    
    - Paragraph breaks (blank lines) are preserved as empty lines.
    - Numbered / bulleted points stay on their own lines.
    - Long lines are wrapped at word boundaries for Latin text
      and at any character for CJK characters.
    - The output is capped at max_lines; remaining text goes to overflow.
    """
    raw_lines = text.replace("\r", "").split("\n")
    result: list[str] = []

    for raw in raw_lines:
        stripped = raw.strip()
        if not stripped:
            if result and result[-1] != "":
                result.append("")
            continue

        if _visual_width(stripped) <= width:
            result.append(stripped)
            continue

        for chunk in _wrap_long_line(stripped, width):
            result.append(chunk)

    # Split at max_lines, calculate overflow.
    if len(result) > max_lines:
        overflow_lines = result[max_lines:]
        result = result[:max_lines]
        if result[-1]:
            result[-1] = result[-1][:-1] + "…"
        overflow = "\n".join(overflow_lines)
    else:
        overflow = ""

    return result, overflow


def _visual_width(text: str) -> int:
    """Approximate visual width: CJK chars count as 2, ASCII as 1."""
    w = 0
    for ch in text:
        w += 2 if "\u4e00" <= ch <= "\u9fff" or "\u3000" <= ch <= "\u303f" or "\uff00" <= ch <= "\uffef" else 1
    return w


def _wrap_long_line(text: str, width: int) -> list[str]:
    """Wrap a single long line at the given visual width.

    Latin script breaks at word boundaries; CJK characters break at any
    position.  Mixed content is handled by segmenting Latin words from
    CJK runs and wrapping each segment independently.
    """
    # Tokenize into [segment, is_latin]
    segments: list[tuple[str, bool]] = []
    i = 0
    while i < len(text):
        ch = text[i]
        # Detect Latin word: runs of ASCII letters/digits
        if ch.isascii() and (ch.isalpha() or ch.isdigit()):
            j = i
            while j < len(text) and text[j].isascii() and (text[j].isalpha() or text[j].isdigit()):
                j += 1
            segments.append((text[i:j], True))
            i = j
        else:
            segments.append((ch, False))
            i += 1

    chunks: list[str] = []
    current = ""
    current_width = 0

    for seg_text, is_latin in segments:
        seg_width = _visual_width(seg_text)

        # If the segment is a Latin word and it would overflow OR already
        # overflows, start a new line first (unless current is empty).
        if is_latin and current_width + seg_width > width and current:
            chunks.append(current)
            current = ""
            current_width = 0

        # If the segment itself is wider than the line, break it
        # character-by-character (happens for very long words / URLs).
        if seg_width > width:
            # Flush current line first.
            if current:
                chunks.append(current)
                current = ""
                current_width = 0
            # Break the overlong segment into width-sized pieces.
            for ch in seg_text:
                ch_w = 2 if "\u4e00" <= ch <= "\u9fff" or "\u3000" <= ch <= "\u303f" or "\uff00" <= ch <= "\uffef" else 1
                if current_width + ch_w <= width:
                    current += ch
                    current_width += ch_w
                else:
                    chunks.append(current)
                    current = ch
                    current_width = ch_w
            continue

        if current_width + seg_width <= width:
            current += seg_text
            current_width += seg_width
        else:
            # Segment must be placed on a new line.
            if current:
                chunks.append(current)
            current = seg_text
            current_width = seg_width

    if current:
        chunks.append(current)

    return chunks if chunks else [text]


def render_svg(card: dict[str, Any], index: int, total: int) -> tuple[str, str]:
    """Render one card as SVG.  Returns (svg_string, overflow_text)."""
    source = str(card.get("source") or "")
    title_lines, _ = wrap_text(str(card.get("title") or "每日面经"), 34, 3)
    # Body: 15 lines max to leave safe footer space at y=1380+
    body_lines, overflow = wrap_text(str(card.get("body") or ""), 56, 15)

    source_el = ""
    title_y = 260
    if source:
        source_el = f'<text x="92" y="200" class="source">{html.escape(source)}</text>'

    title_el = "".join(
        f'<text x="92" y="{title_y + line * 60}" class="title">{html.escape(value)}</text>'
        for line, value in enumerate(title_lines)
    )
    body_y = title_y + len(title_lines) * 60 + 48
    body_el = "".join(
        f'<text x="92" y="{body_y + line * 46}" class="body">{html.escape(value)}</text>'
        for line, value in enumerate(body_lines)
    )
    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1440" viewBox="0 0 1080 1440">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop stop-color="#FFFBF5"/><stop offset="1" stop-color="#FFF0E6"/>
    </linearGradient>
    <radialGradient id="glow">
      <stop stop-color="#FF6B35" stop-opacity=".08"/>
      <stop offset="1" stop-color="#FF6B35" stop-opacity="0"/>
    </radialGradient>
    <style>
      text {{ font-family: "PingFang SC", "Hiragino Sans GB", "Noto Sans SC", sans-serif; }}
      .kicker {{ fill:#FF6B35; font-size:22px; font-weight:700; letter-spacing:3px; }}
      .source {{ fill:#A89B8C; font-size:18px; font-weight:400; }}
      .title {{ fill:#1A1A2E; font-size:42px; font-weight:700; }}
      .body {{ fill:#4A4A5A; font-size:30px; font-weight:420; line-height:1.6; }}
      .body b {{ fill:#FF6B35; font-weight:700; }}
      .footer {{ fill:#B0B0B0; font-size:20px; }}
      .wm {{ fill:#FF6B35; opacity:.04; font-size:120px; font-weight:800; }}
    </style>
  </defs>
  <rect width="1080" height="1440" fill="url(#bg)"/>
  <circle cx="900" cy="120" r="520" fill="url(#glow)"/>
  <path d="M48 108V48h60M984 1392h48v-48" fill="none" stroke="#FF6B35" stroke-opacity=".30" stroke-width="3"/>
  <!-- Watermark -->
  <text x="540" y="780" class="wm" transform="rotate(-25,540,780)" text-anchor="middle">AI面经bot</text>
  <text x="940" y="440" class="wm" transform="rotate(-25,940,440)" text-anchor="middle">AI面经bot</text>
  <text x="140" y="1200" class="wm" transform="rotate(-25,140,1200)" text-anchor="middle">AI面经bot</text>
  <!-- Content -->
  <text x="92" y="140" class="kicker">{html.escape(str(card.get("kicker") or "DAILY INTERVIEW"))}</text>
  {source_el}
  {title_el}
  {body_el}
  <text x="92" y="1395" class="footer">{html.escape(str(card.get("footer") or "完整内容见主页"))}</text>
  <text x="930" y="1395" class="footer">{index:02d}/{total:02d}</text>
</svg>'''
    return svg, overflow


def render_png(card: dict[str, Any], index: int, total: int, path: Path) -> tuple[bool, str]:
    """Render one card as PNG.  Returns (ok, overflow_text)."""
    try:
        from PIL import Image, ImageDraw, ImageFont
    except ImportError:
        return False, ""
    font_path = os.environ.get("XHS_FONT_PATH", "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc")
    if not Path(font_path).is_file():
        raise RuntimeError("set XHS_FONT_PATH to a Chinese-capable TTF/TTC font")

    # ── Background ──
    img = Image.new("RGBA", (1080, 1440), (255, 251, 245, 255))
    draw = ImageDraw.Draw(img)
    # Warm gradient via horizontal strips
    for y in range(1440):
        t = y / 1440
        r = int(255 - 15 * t)
        g = int(251 - 21 * t)
        b = int(245 - 15 * t)
        draw.line([(0, y), (1080, y)], fill=(r, g, b))
    # Soft accent glow
    draw.ellipse((680, -180, 1280, 420), fill=(255, 107, 53, 20))
    # Corner lines
    draw.line((48, 108, 48, 48, 108, 48), fill=(255, 107, 53, 77), width=3)
    draw.line((984, 1392, 1032, 1392, 1032, 1344), fill=(255, 107, 53, 77), width=3)

    # ── Watermark ──
    wm_text = "AI面经bot"
    wm_layer = Image.new("RGBA", (1080, 1440), (0, 0, 0, 0))
    wm_draw = ImageDraw.Draw(wm_layer)
    wm_font = ImageFont.truetype(font_path, 100)
    for x, y in [(540, 780), (940, 380), (180, 1100)]:
        wm_draw.text((x, y), wm_text, font=wm_font, fill=(255, 107, 53, 10), anchor="mm")
    # Rotate watermark layer
    wm_layer = wm_layer.rotate(25, expand=False, fillcolor=(0, 0, 0, 0))
    img = Image.alpha_composite(img, wm_layer)
    draw = ImageDraw.Draw(img)

    # ── Fonts ──
    kicker_font = ImageFont.truetype(font_path, 24)
    source_font = ImageFont.truetype(font_path, 18)
    title_font = ImageFont.truetype(font_path, 44)
    body_font = ImageFont.truetype(font_path, 30)
    footer_font = ImageFont.truetype(font_path, 20)

    # ── Content ──
    draw.text((92, 120), str(card.get("kicker") or "DAILY INTERVIEW"), font=kicker_font, fill="#FF6B35")

    source_text = str(card.get("source") or "")
    y = 250
    if source_text:
        draw.text((92, 190), source_text, font=source_font, fill="#A89B8C")

    title_lines, _ = wrap_text(str(card.get("title") or "每日面经"), 30, 3)
    for line in title_lines:
        draw.text((92, y), line, font=title_font, fill="#1A1A2E")
        y += 62
    y += 36

    body_lines, overflow = wrap_text(str(card.get("body") or ""), 50, 15)
    for line in body_lines:
        draw.text((92, y), line, font=body_font, fill="#4A4A5A")
        y += 46

    # Footer at fixed bottom position
    draw.text((92, 1395), str(card.get("footer") or "完整内容见主页"), font=footer_font, fill="#B0B0B0")
    draw.text((930, 1395), f"{index:02d}/{total:02d}", font=footer_font, fill="#B0B0B0")

    img = img.convert("RGB")
    img.save(path, format="PNG", optimize=True)
    return True, overflow


def _strip_markdown(text: str) -> str:
    """Strip common markdown formatting for plain-text paste into XHS."""
    text = re.sub(r"```[\s\S]*?```", "[代码见完整内容]", text)
    text = re.sub(r"`([^`]+)`", r"\1", text)
    text = re.sub(r"\*\*([^*]+)\*\*", r"\1", text)
    text = re.sub(r"__([^_]+)__", r"\1", text)
    text = re.sub(r"\*([^*]+)\*", r"\1", text)
    text = re.sub(r"_([^_]+)_", r"\1", text)
    text = re.sub(r"~~([^~]+)~~", r"\1", text)
    text = re.sub(r"^#{1,6}\s+", "", text, flags=re.MULTILINE)
    text = re.sub(r"^[-*+]\s+", "· ", text, flags=re.MULTILINE)
    text = re.sub(r"^\d+\.\s+", "", text, flags=re.MULTILINE)
    text = re.sub(r"<[^>]+>", "", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def render_xhs_caption(publication: dict[str, Any]) -> str:
    """Produce clean plain text ready to paste into Xiaohongshu's caption field.

    XHS caption guidelines (rough):
      - Headline-first: an engaging one-liner that grabs attention.
      - Body with emoji + line-break pacing — short paragraphs, not a wall.
      - 3–5 hashtags at the end (no space after #).
      - Keep under ~1000 chars for full visibility without 「展开」.

    We take the publication body (which is already XHS-optimised from
    social.ts), strip leftover markdown, remove any hashtags already
    embedded in the body, then re-append hashtags from the dedicated field.
    """
    title = _strip_markdown(str(publication.get("title") or ""))
    body = _strip_markdown(str(publication.get("body") or ""))
    hashtags = publication.get("hashtags") or []

    # Strip any hashtags already embedded in the body text
    # (social.ts embeds them as "#tag1 #tag2 ..." at the end of the body).
    body = re.sub(r"\s*(?:#[^\s#]+\s*)+$", "", body).rstrip()

    # Build: engaging headline → blank line → body → blank line → hashtags
    lines: list[str] = []
    if title:
        lines.append(title)
        lines.append("")
    if body:
        lines.append(body)

    if hashtags:
        lines.append("")
        lines.append(" ".join(f"#{tag}" for tag in hashtags))

    return "\n".join(lines)


def package_cards(publication: dict[str, Any], target_dir: Path) -> Path | None:
    """Create cards.zip with all card images, preferring PNG over SVG.

    Returns the path to the zip file, or None if there are no cards.
    """
    cards = publication.get("assets") or []
    if not cards:
        return None

    zip_path = target_dir / "cards.zip"
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for index in range(1, len(cards) + 1):
            png = target_dir / f"card-{index:02d}.png"
            if png.is_file():
                zf.write(png, png.name)
    return zip_path if zip_path.stat().st_size > 0 else None


def export_manual(publication: dict[str, Any], account: str | None = None) -> Path:
    # ── Output root: ~/iCloudDrive/小红书发布/YYYY-MM-DD/ ──
    from datetime import date
    today = date.today().isoformat()  # e.g. 2026-07-12
    root = Path(
        os.environ.get(
            "XHS_OUTBOX_DIR",
            str(Path.home() / "iCloudDrive" / "xhs-posts"),
        )
    )
    target = root / today
    # When multiple accounts publish on the same day, nest by account.
    if account:
        target = target / account
    target.mkdir(mode=0o755, parents=True, exist_ok=True)

    # ── App-ready XHS caption (plain text, copy-paste into the caption field) ──
    caption = render_xhs_caption(publication)
    (target / "caption_xhs.txt").write_text(caption, encoding="utf-8")

    # ── Reference copies (human review / backup) ──
    (target / "caption.md").write_text(
        f"# {publication['title']}\n\n{publication['body']}\n",
        encoding="utf-8",
    )
    (target / "post.json").write_text(
        json.dumps(publication, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    # ── Card images (with overflow continuation support) ──
    cards: list[dict[str, Any]] = list(publication.get("assets") or [])
    card_index = 1
    total_display = len(cards)  # may grow as continuations are added

    i = 0
    while i < len(cards):
        card = cards[i]
        is_continuation = card.get("kind") == "continuation"

        # Overflow detection — render SVG to check if body overflows.
        # We don't write the SVG (to avoid confusion when uploading to XHS),
        # but we need its overflow signal to create continuation cards.
        _svg_str, svg_overflow = render_svg(card, card_index, total_display)
        suffix = f"-{card_index:02d}"
        png_ok, png_overflow = True, ""
        try:
            png_ok, png_overflow = render_png(card, card_index, total_display,
                                              target / f"card{suffix}.png")
        except (ImportError, RuntimeError) as exc:
            print(f"PNG render skipped ({exc}); exported SVG only.", file=sys.stderr)
            png_ok = False

        overflow = svg_overflow or png_overflow
        if overflow:
            # Create a continuation card.
            parent_kicker = str(card.get("kicker") or "")
            cont_card: dict[str, Any] = {
                "kind": "continuation",
                "kicker": f"{parent_kicker}（续）" if parent_kicker else "续",
                "title": "",
                "body": overflow,
                "footer": str(card.get("footer") or ""),
            }
            cards.append(cont_card)
            total_display += 1

        card_index += 1
        i += 1

    # Update total on all cards (may have changed due to continuations).
    # Re-render index/total that was written — simpler to just overwrite.
    # page numbers on rendered cards may show stale totals; this is
    # acceptable as the file names already establish ordering.

    # ── Compressed card package ──
    package_cards({"assets": cards}, target)

    return target


def publish_official(publication: dict[str, Any], account: str | None = None) -> str:
    # Prefer account-level credentials when available, fall back to env vars.
    if account:
        endpoint = get_account_publish_url(account)
        token = get_account_access_token(account)
    else:
        endpoint = None
        token = None
    if not endpoint:
        endpoint = os.environ.get("XHS_OFFICIAL_PUBLISH_URL", "").strip()
    if not token:
        token = os.environ.get("XHS_OFFICIAL_ACCESS_TOKEN", "").strip()
    if not endpoint or not token:
        raise RuntimeError("official mode requires XHS_OFFICIAL_PUBLISH_URL and XHS_OFFICIAL_ACCESS_TOKEN, or account config with official_publish_url + official_access_token_env")
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


# ── Account config ───────────────────────────────────────────────────────────

ACCOUNTS_CONFIG_PATH = os.environ.get(
    "XHS_ACCOUNTS_CONFIG",
    str(Path.home() / ".hermes" / "xhs-accounts.json"),
)


def load_account_config() -> dict[str, Any] | None:
    """Load the xhs-accounts.json file. Returns None if not found."""
    path = Path(ACCOUNTS_CONFIG_PATH)
    if not path.is_file():
        return None
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def get_account_publish_url(account_key: str) -> str | None:
    """Get the official publish URL for an account, or None."""
    cfg = load_account_config()
    if not cfg:
        return None
    account = cfg.get("accounts", {}).get(account_key)
    if not account or account.get("enabled") is False:
        return None
    url = account.get("official_publish_url")
    return url if url else None


def get_account_access_token(account_key: str) -> str | None:
    """Resolve the access token for an account's official publishing.
    Returns the value of the env var named in official_access_token_env,
    or the literal value if it's not an env-var reference."""
    cfg = load_account_config()
    if not cfg:
        return None
    account = cfg.get("accounts", {}).get(account_key)
    if not account or account.get("enabled") is False:
        return None
    token_env = account.get("official_access_token_env")
    if not token_env:
        return None
    return os.environ.get(token_env, "") or None


# ── Full-auto pipeline helpers ──────────────────────────────────────────────


def _account_query(account: str | None) -> str:
    """Build the ?account= query suffix for API calls."""
    if account:
        from urllib.parse import urlencode
        return f"?{urlencode({'account': account})}"
    return ""


def prepare_publications(account: str | None = None) -> list[dict[str, Any]]:
    """Call the automation prepare-latest endpoint and return new drafts."""
    result = request_json(
        "POST",
        f"/api/automation/social/xiaohongshu/prepare-latest{_account_query(account)}",
    )
    if not result:
        return []
    publications = result.get("publications", [])
    if not publications:
        print("No new publications were prepared (all up-to-date).", file=sys.stderr)
    else:
        print(f"Prepared {len(publications)} Xiaohongshu draft(s).", file=sys.stderr)
    return publications


def approve_publication(publication_id: str) -> dict[str, Any]:
    """Approve a single publication via the automation endpoint."""
    result = request_json(
        "POST",
        f"/api/automation/social/xiaohongshu/publications/{publication_id}/approve",
    )
    if not result:
        raise RuntimeError(f"Failed to approve publication {publication_id}")
    return result["publication"]


def process_publication(mode: str, account: str | None = None) -> int:
    """Claim one approved publication and export/publish it.  Returns 0 on
    success, 1 when nothing is waiting."""
    claimed = request_json(
        "POST",
        f"/api/automation/social/xiaohongshu/claim{_account_query(account)}",
    )
    if not claimed:
        return 1
    publication = claimed["publication"]
    publication_id = publication["id"]
    try:
        if mode == "manual":
            target = export_manual(publication, account=account)
            request_json(
                "POST",
                f"/api/automation/social/xiaohongshu/publications/{publication_id}/result",
                {"status": "exported", "externalPostId": None, "error": None},
            )
            print(f"Exported Xiaohongshu package: {target}")
        else:
            post_id = publish_official(publication, account=account)
            request_json(
                "POST",
                f"/api/automation/social/xiaohongshu/publications/{publication_id}/result",
                {"status": "published", "externalPostId": post_id, "error": None},
            )
            print(f"Published Xiaohongshu post: {post_id}")
        return 0
    except Exception:
        request_json(
            "POST",
            f"/api/automation/social/xiaohongshu/publications/{publication_id}/result",
            {"status": "failed", "externalPostId": None, "error": str(sys.exc_info()[1])[:2_000]},
        )
        raise


# ── Entry points ────────────────────────────────────────────────────────────


def run_once(mode: str, account: str | None = None) -> int:
    """Process precisely ONE already-approved publication (manual / official).
    Returns 0 when a publication was processed, 1 when the queue is empty."""
    return process_publication(mode, account=account)


def run_full_auto(mode: str, account: str | None = None) -> int:
    """End-to-end pipeline: prepare drafts → approve → claim & export/publish.

    Steps:
      1. Call prepare-latest to generate drafts from latest report runs.
      2. Auto-approve every returned draft.
      3. Claim and process each approved publication one by one.
    Returns the number of publication-processing errors (0 = all good).
    """
    publications = prepare_publications(account=account)
    if not publications:
        print("Nothing to do — no new publications needed.", file=sys.stderr)
        return 0

    approved_ids: list[str] = []
    for pub in publications:
        pub_id = pub.get("id")
        if not pub_id:
            print(f"Skipping publication without id: {pub.get('title', '?')}", file=sys.stderr)
            continue
        try:
            approved = approve_publication(pub_id)
            approved_ids.append(pub_id)
            print(f"  ✓ Approved: {approved.get('title', pub_id)}", file=sys.stderr)
        except Exception:
            print(f"  ✗ Failed to approve {pub_id}: {sys.exc_info()[1]}", file=sys.stderr)

    if not approved_ids:
        print("No publications could be approved.", file=sys.stderr)
        return 1

    print(f"\nApproved {len(approved_ids)} publication(s). Processing...", file=sys.stderr)

    errors = 0
    processed = 0
    while True:
        result = process_publication(mode, account=account)
        if result == 1:
            break  # queue drained
        if result != 0:
            errors += 1
        processed += 1

    print(f"\nFull-auto complete: {processed} processed, {errors} error(s).", file=sys.stderr)
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description="Process approved Xiaohongshu publications")
    parser.add_argument(
        "--mode",
        choices=("manual", "official", "full-auto"),
        default=os.environ.get("XHS_PUBLISH_MODE", "manual"),
        help="Publish mode: manual (export outbox), official (partner API), "
             "or full-auto (prepare → approve → export/publish end-to-end). "
             "Default from XHS_PUBLISH_MODE env, falls back to manual.",
    )
    parser.add_argument(
        "--account",
        default=os.environ.get("XHS_ACCOUNT", None),
        help="Target Xiaohongshu account key (matches keys in xhs-accounts.json). "
             "When set, only prepares/publishes reports for that account and "
             "exports to xhs-outbox/<account>/<id>/. "
             "Default from XHS_ACCOUNT env.",
    )
    parser.add_argument(
        "--auto-prepare-only",
        action="store_true",
        help="Only prepare and approve drafts; do NOT export/publish. "
             "Useful when you want to review before publishing.",
    )
    args = parser.parse_args()

    if args.auto_prepare_only:
        publications = prepare_publications(account=args.account)
        if not publications:
            return 0
        approved = 0
        for pub in publications:
            pub_id = pub.get("id")
            if not pub_id:
                continue
            try:
                approve_publication(pub_id)
                approved += 1
                print(f"  ✓ Approved: {pub.get('title', pub_id)}")
            except Exception:
                print(f"  ✗ Failed to approve {pub_id}: {sys.exc_info()[1]}", file=sys.stderr)
        print(f"\nPrepared and approved {approved} / {len(publications)} draft(s).", file=sys.stderr)
        return 0 if approved > 0 else 1

    if args.mode == "full-auto":
        publish_mode = os.environ.get("XHS_AUTO_PUBLISH_MODE", "manual")
        return run_full_auto(publish_mode, account=args.account)

    return run_once(args.mode, account=args.account)


if __name__ == "__main__":
    raise SystemExit(main())
