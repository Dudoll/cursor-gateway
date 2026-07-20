import importlib.util
from pathlib import Path

MODULE = Path(__file__).with_name("hermes_cursor_runner.py")
spec = importlib.util.spec_from_file_location("hermes_cursor_runner", MODULE)
assert spec is not None and spec.loader is not None
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


def test_build_prompt_stays_below_single_argument_limit():
    job = {
        "prompt": "BEGIN-CURRENT\n" + ("研究素材甲乙丙" * 40000) + "\nEND-CURRENT",
        "history": [{"role": "user", "content": "history" * 50000}],
        "memory": ["memory" * 50000],
    }
    prompt = runner.build_prompt(job)
    assert len(prompt.encode("utf-8")) <= 120_000
    assert "BEGIN-CURRENT" in prompt
    assert "END-CURRENT" in prompt
    assert "[内容因命令行长度限制已压缩]" in prompt
