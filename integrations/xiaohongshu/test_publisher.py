from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import publisher


class XiaohongshuPublisherTests(unittest.TestCase):
    def test_wrap_text_is_bounded(self) -> None:
        lines = publisher.wrap_text("A" * 100, width=10, max_lines=3)
        self.assertEqual(len(lines), 3)
        self.assertTrue(lines[-1].endswith("…"))

    def test_svg_escapes_untrusted_report_text(self) -> None:
        svg = publisher.render_svg(
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

    def test_manual_export_writes_private_package(self) -> None:
        publication = {
            "id": "publication-test",
            "title": "AI Agent 面经",
            "body": "caption",
            "assets": [
                {
                    "kicker": "DAILY",
                    "title": "Tool calling",
                    "body": "answer",
                    "footer": "complete",
                }
            ],
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
            self.assertEqual(target, Path(temp) / "publication-test")
            self.assertTrue((target / "caption.md").is_file())
            self.assertTrue((target / "post.json").is_file())
            self.assertTrue((target / "card-01.svg").is_file())


if __name__ == "__main__":
    unittest.main()
