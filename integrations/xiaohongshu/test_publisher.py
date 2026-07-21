from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import publisher


class XiaohongshuPublisherTests(unittest.TestCase):
    def test_wrap_text_is_bounded(self) -> None:
        lines, overflow = publisher.wrap_text("A" * 60, width=10, max_lines=3)
        self.assertEqual(len(lines), 3)
        self.assertTrue(lines[-1].endswith("…"))
        self.assertTrue(overflow)  # text was truncated

    def test_wrap_text_preserves_numbered_lines(self) -> None:
        text = "1. First point here\n2. Second point here\n3. Third point here"
        lines, overflow = publisher.wrap_text(text, width=50, max_lines=10)
        self.assertIn("1. First point here", lines)
        self.assertIn("2. Second point here", lines)
        self.assertIn("3. Third point here", lines)
        self.assertEqual(overflow, "")

    def test_wrap_text_preserves_paragraph_breaks(self) -> None:
        text = "Paragraph one.\n\nParagraph two."
        lines, _ = publisher.wrap_text(text, width=50, max_lines=10)
        self.assertIn("", lines)

    def test_wrap_text_returns_overflow(self) -> None:
        text = "line1\nline2\nline3\nline4\nline5"
        lines, overflow = publisher.wrap_text(text, width=80, max_lines=3)
        self.assertEqual(len(lines), 3)
        self.assertIn("line4", overflow)
        self.assertIn("line5", overflow)

    def test_svg_escapes_untrusted_report_text(self) -> None:
        svg, _ = publisher.render_svg(
            {
                "kicker": "AI & AGENT",
                "title": "<script>alert(1)</script>",
                "body": "Q&A",
                "footer": "site.example",
            },
            1,
            2,
        )
        self.assertNotIn("<script>", svg)
        self.assertIn("&lt;script&gt;", svg)
        self.assertIn("AI &amp; AGENT", svg)

    def test_svg_includes_source_line(self) -> None:
        svg, _ = publisher.render_svg(
            {
                "kicker": "Q1 · Test",
                "source": "来源线索： Reddit",
                "title": "What is Prefix Cache?",
                "body": "Answer here.",
                "footer": "2026-07-12",
            },
            1,
            2,
        )
        self.assertIn("来源线索", svg)
        self.assertIn('class="source"', svg)

    def test_svg_returns_overflow_on_long_body(self) -> None:
        body = "\n".join(f"Line {i}" for i in range(50))
        _, overflow = publisher.render_svg(
            {"kicker": "Q1", "title": "Test", "body": body, "footer": "f"},
            1, 1,
        )
        self.assertTrue(overflow)

    def test_manual_export_writes_private_package(self) -> None:
        publication = {
            "id": "publication-test",
            "title": "AI Agent 面经",
            "body": "caption",
            "hashtags": ["AI面试"],
            "assets": [],
        }
        with tempfile.TemporaryDirectory() as temp:
            previous = publisher.os.environ.get("XHS_OUTBOX_DIR")
            publisher.os.environ["XHS_OUTBOX_DIR"] = temp
            try:
                target = publisher.export_manual(publication)
            finally:
                if previous is None:
                    publisher.os.environ.pop("XHS_OUTBOX_DIR", None)
                else:
                    publisher.os.environ["XHS_OUTBOX_DIR"] = previous
            from datetime import date
            self.assertIn(date.today().isoformat(), str(target))
            self.assertTrue((target / "caption_xhs.txt").is_file())

    def test_export_with_overflow_creates_continuation_cards(self) -> None:
        """Body that overflows should generate continuation card files (PNG only)."""
        body = "\n".join(f"Line {i}" for i in range(50))
        publication = {
            "id": "test-overflow",
            "title": "Test",
            "body": "body",
            "hashtags": [],
            "assets": [{
                "kind": "question",
                "kicker": "Q1 · Test",
                "source": "来源：Test",
                "title": "Question?",
                "body": body,
                "footer": "footer",
            }],
        }
        with tempfile.TemporaryDirectory() as temp:
            previous = publisher.os.environ.get("XHS_OUTBOX_DIR")
            publisher.os.environ["XHS_OUTBOX_DIR"] = temp
            try:
                target = publisher.export_manual(publication)
            finally:
                if previous is None:
                    publisher.os.environ.pop("XHS_OUTBOX_DIR", None)
                else:
                    publisher.os.environ["XHS_OUTBOX_DIR"] = previous
            # Should have at least 2 PNG card files (original + continuation)
            pngs = sorted(target.glob("card-*.png"))
            self.assertGreaterEqual(len(pngs), 2, f"Expected ≥2 cards, got {len(pngs)}: {[p.name for p in pngs]}")
            # No SVG files should be written
            svgs = list(target.glob("card-*.svg"))
            self.assertEqual(len(svgs), 0, f"Expected 0 SVGs, got {svgs}")

    def test_xhs_caption_produces_plain_text(self) -> None:
        publication = {
            "title": "AI Infra 大厂面经｜每日精选",
            "body": "**今日重点**：GPU 调度与推理优化。\n\n详细内容见主页。",
            "hashtags": ["AI面试", "AIInfra"],
        }
        caption = publisher.render_xhs_caption(publication)
        self.assertNotIn("**", caption)
        self.assertIn("GPU", caption)
        self.assertIn("#AI面试", caption)

    def test_account_query_encoding(self) -> None:
        self.assertEqual(publisher._account_query(None), "")
        self.assertEqual(publisher._account_query(""), "")
        self.assertIn("account=ai-infra", publisher._account_query("ai-infra"))


if __name__ == "__main__":
    unittest.main()
