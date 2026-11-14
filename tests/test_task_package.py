from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PROGRAM = ROOT / "scene_retrieval.py"


def _run(*args: str, cwd: Path | None = None) -> dict:
    result = subprocess.run(
        [sys.executable, str(PROGRAM), *args],
        cwd=cwd or ROOT,
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(result.stdout)


def _make_index(tmp_path: Path) -> tuple[Path, Path]:
    source = tmp_path / "sample-book.txt"
    source.write_text(
        "标题\n第七章 星火\n守军在东门升起红旗，随后城中援军打开了城门。\n",
        encoding="gb18030",
    )
    index = tmp_path / "资料索引.json"
    _run(
        "build-index",
        "--source",
        str(source),
        "--start-line",
        "2",
        "--end-line",
        "2",
        "--output",
        str(index),
    )
    return source, index


def test_package_is_movable_and_rewrites_old_index_references(tmp_path: Path) -> None:
    source, index = _make_index(tmp_path)
    requirements = tmp_path / "视频需求.md"
    requirements.write_text(
        "# 视频需求：城中援军\n\n"
        "## 想讲的内容\n讲清援军打开城门的经过。\n\n"
        "## 参考资料（有则填写）\n"
        f"- 原著：{source}\n"
        "- 参考网页：https://example.com/history\n"
        "- 本地索引：/old/workspace/runs/task/资料索引.json\n"
        "- 检索状态：candidate，尚未印证。\n",
        encoding="utf-8",
    )
    package = tmp_path / "交接包"

    result = _run(
        "package",
        "--requirements",
        str(requirements),
        "--index",
        str(index),
        "--output",
        str(package),
    )

    assert result["files"] == ["视频需求.md", "资料索引.json", "scene_retrieval.py"]
    assert {path.name for path in package.iterdir()} == set(result["files"])
    document = (package / "视频需求.md").read_text(encoding="utf-8")
    assert "https://example.com/history" in document
    assert "/old/workspace" not in document
    assert str(source) not in document
    assert source.name in document
    assert "candidate" in document
    assert "尚未印证" in document
    assert "本次索引章节：星火" in document
    assert "./资料索引.json" in document
    assert "./scene_retrieval.py" in document
    assert "`found`" in document and "`candidate`" in document and "`not_found`" in document

    packaged_index = json.loads((package / "资料索引.json").read_text(encoding="utf-8"))
    assert packaged_index["source_file"] == source.name
    assert all(passage["source_file"] == source.name for passage in packaged_index["passages"])
    assert str(source) not in json.dumps(packaged_index, ensure_ascii=False)

    source.unlink()
    index.unlink()
    requirements.unlink()
    relocated = tmp_path / "relocated" / "handoff"
    relocated.parent.mkdir()
    shutil.move(str(package), relocated)
    found = _run(
        "query",
        "--index",
        "./资料索引.json",
        "--query",
        "守军在东门",
        cwd=relocated,
    )
    assert found["status"] == "found"


def test_package_without_index_contains_no_query_tool_or_stale_paths(
    tmp_path: Path,
) -> None:
    requirements = tmp_path / "视频需求.md"
    requirements.write_text(
        "# 视频需求：雨后彩虹\n\n"
        "## 参考资料\n"
        "- 用户提供的图片待补。\n"
        "- 索引：runs/old/资料索引.json\n"
        "- 状态：not_found\n",
        encoding="utf-8",
    )
    package = tmp_path / "交接包"

    _run(
        "package",
        "--requirements",
        str(requirements),
        "--output",
        str(package),
    )

    assert [path.name for path in package.iterdir()] == ["视频需求.md"]
    document = (package / "视频需求.md").read_text(encoding="utf-8")
    assert "用户提供的图片待补" in document
    assert "runs/old" not in document
    assert "not_found" in document
    assert "索引：资料索引.json（本包未附）" in document
    assert "本包未附场面引用索引" in document


def test_package_preserves_constraints_and_status_sharing_a_stale_index_line(
    tmp_path: Path,
) -> None:
    source, index = _make_index(tmp_path)
    requirements = tmp_path / "视频需求.md"
    requirements.write_text(
        "# 视频需求：返程商旅\n\n"
        "## 参考资料\n"
        "- 资料索引.json 仅含出发片段；返程未取得，请勿据此描写返程。\n"
        "- 对投降先后顺序的检索状态为 candidate，仍待核对。\n"
        f"- 旧工作区索引：{tmp_path}/old/资料索引.json；对应段落有删节。\n",
        encoding="utf-8",
    )
    package = tmp_path / "交接包"

    _run(
        "package",
        "--requirements",
        str(requirements),
        "--index",
        str(index),
        "--output",
        str(package),
    )

    document = (package / "视频需求.md").read_text(encoding="utf-8")
    assert "仅含出发片段；返程未取得，请勿据此描写返程" in document
    assert "对投降先后顺序" in document
    assert "candidate" in document
    assert "仍待核对" in document
    assert "旧工作区索引" in document
    assert "对应段落有删节" in document
    assert str(tmp_path) not in document
    assert "旧工作区索引：资料索引.json；对应段落有删节" in document
