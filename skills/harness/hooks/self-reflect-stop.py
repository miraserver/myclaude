#!/usr/bin/env python3
"""Self-reflection Stop hook — harness 任务循环完成后注入自省 prompt。

仅在以下条件同时满足时生效：
  1. harness-tasks.json 存在（harness 曾被初始化）
  2. .harness-reflect 存在（其中保存本次完成后的自省迭代计数）

当 harness 未曾启动时，本 hook 是完全的 no-op。

配置:
  - REFLECT_MAX_ITERATIONS 环境变量（默认 5）
  - 设为 0 可禁用
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any, Optional

# Add hooks directory to sys.path for _harness_common import
sys.path.insert(0, str(Path(__file__).resolve().parent))
import _harness_common as hc

DEFAULT_MAX_ITERATIONS = 5


def _find_harness_root(payload: dict[str, Any]) -> Optional[Path]:
    return hc.find_harness_root(payload, reflection=True)


def _read_counter(marker: Path) -> int:
    """Read the iteration count for this harness completion."""
    try:
        return int(json.loads(marker.read_text("utf-8"))["count"])
    except Exception:
        return 0


def _write_counter(marker: Path, count: int, session_id: str) -> None:
    try:
        marker.write_text(json.dumps({"session_id": session_id, "count": count}), encoding="utf-8")
    except Exception:
        pass


def _user_text(entry: Any) -> str:
    """Extract prompt text from a non-synthetic user transcript entry."""
    if not isinstance(entry, dict) or entry.get("isMeta") or entry.get("isCompactSummary"):
        return ""
    message = entry.get("message")
    if not isinstance(message, dict):
        message = entry
    role = message.get("role") or entry.get("role") or entry.get("type", "")
    if role != "user":
        return ""
    content = message.get("content", entry.get("content", ""))
    if isinstance(content, list):
        texts = []
        for block in content:
            if isinstance(block, dict):
                if block.get("type") == "tool_result":
                    continue
                text = block.get("text", "")
                if isinstance(text, str) and text:
                    texts.append(text)
            elif isinstance(block, str):
                texts.append(block)
        content = "\n".join(texts)
    if not isinstance(content, str) or not content.strip():
        return ""
    if len(content) > 2000:
        content = content[:2000] + "..."
    return content.strip()


def _transcript_user_text(line: str) -> str:
    """Ignore blank or malformed JSONL records when extracting user text."""
    try:
        return _user_text(json.loads(line))
    except Exception:
        return ""


def _extract_original_prompt(transcript_path: str, max_bytes: int = 100_000) -> str:
    """从 transcript JSONL 中提取第一条用户消息作为原始 prompt。"""
    try:
        p = Path(transcript_path)
        if not p.is_file():
            return ""
        with p.open("r", encoding="utf-8") as f:
            # Read JSONL lazily, stopping at the first nonempty user prompt.
            return next(filter(None, map(_transcript_user_text, f)), "")
    except Exception:
        pass
    return ""


def main() -> int:
    payload = hc.read_hook_payload()
    session_id = payload.get("session_id", "")
    if not session_id:
        return 0  # 无 session_id，放行

    # 守卫：仅当 harness 完成所有任务后（.harness-reflect 存在）才触发自省
    # 这避免了两个问题：
    #   1. 历史残留的 harness-tasks.json 导致误触发（false positive）
    #   2. harness-stop.py 移除 .harness-active 后 Claude Code 跳过后续 hook（false negative）
    root = _find_harness_root(payload)
    if root is None:
        return 0

    marker = root / ".harness-reflect"
    if not marker.is_file():
        return 0

    try:
        marker_session = json.loads(marker.read_text("utf-8")).get("session_id")
    except (ValueError, AttributeError, OSError):
        marker_session = None
    if marker_session != session_id:
        try:
            marker.unlink(missing_ok=True)
            hc.clear_reflection(root)
        except Exception:
            pass
        return 0

    # 读取最大迭代次数
    try:
        max_iter = int(os.environ.get("REFLECT_MAX_ITERATIONS", DEFAULT_MAX_ITERATIONS))
    except (ValueError, TypeError):
        max_iter = DEFAULT_MAX_ITERATIONS

    # 禁用
    if max_iter <= 0:
        return 0

    # 读取当前计数
    count = _read_counter(marker)

    # 超过最大次数，清理 marker 并放行
    if count >= max_iter:
        try:
            marker.unlink(missing_ok=True)
            hc.clear_reflection(root)
        except Exception:
            pass
        return 0

    # 递增计数
    _write_counter(marker, count + 1, session_id)

    # 提取原始 prompt
    transcript_path = payload.get("transcript_path", "")
    original_prompt = _extract_original_prompt(transcript_path)
    last_message = payload.get("last_assistant_message", "")
    if last_message and len(last_message) > 3000:
        last_message = last_message[:3000] + "..."

    # 构建自省 prompt
    parts = [
        f"[Self-Reflect] 迭代 {count + 1}/{max_iter} — 请在继续之前进行自省检查：",
    ]

    if original_prompt:
        parts.append(f"\n📋 原始请求：\n{original_prompt}")

    parts.append(
        "\n🔍 自省清单："
        "\n1. 对照原始请求，逐项确认每个需求点是否已完整实现"
        "\n2. 检查是否有遗漏的边界情况、错误处理或异常场景"
        "\n3. 代码质量：是否有可以改进的地方（可读性、性能、安全性）"
        "\n4. 是否需要补充测试或文档"
        "\n5. 最终确认：所有改动是否一致且不互相冲突"
        "\n\n如果一切已完成，简要总结成果即可结束。如果发现问题，继续修复。"
    )

    reason = "\n".join(parts)

    print(json.dumps({"decision": "block", "reason": reason}, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
