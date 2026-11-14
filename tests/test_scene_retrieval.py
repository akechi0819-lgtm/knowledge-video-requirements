from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
PROGRAM = ROOT / "scene_retrieval.py"
SOURCE_TEXT = (
    "《样本文本》\n"
    "第七十二章 奔援\n"
    "\n"
    "    较早的前情标记是北洛水一带的旧事。    末段过渡标记：宋军夜渡龙门后收到军令。\n"
    "第七十三章 军令\n"
    "\n"
    "    双方既已出兵，便不能不战。\n"
    "七十四章 鹰扬\n"
    "\n"
    "    阳光微微偏西，中军大营的诸将仍在观战。\n"
    "第七十五章 乱战\n"
    "\n"
    "    吴玠请官家立起龙纛，为我等之后。\n"
    "第七十六章 落雕\n"
    "\n"
    "    龙纛立起来一刻钟后，宋军全军大振，继续投入战斗。\n"
    "第七十七章 不忘（上）\n"
    "\n"
    "    夏雨滂沱，龙纛仍在营中飘扬，雨中众人暂且休战。\n"
)


@pytest.fixture
def source_path(tmp_path: Path) -> Path:
    path = tmp_path / "样本文本.txt"
    path.write_bytes(SOURCE_TEXT.encode("gb18030"))
    return path


def _run(*args: str, cwd: Path | None = None) -> dict:
    result = subprocess.run(
        [sys.executable, str(PROGRAM), *args],
        cwd=cwd or ROOT,
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(result.stdout)


def test_inspect_finds_headings_and_handles_missing_chapter_prefix(
    source_path: Path,
) -> None:
    result = _run("inspect", "--source", str(source_path))

    assert [item["number"] for item in result["chapters"]] == [72, 73, 74, 75, 76, 77]
    assert result["chapters"][2]["title"] == "鹰扬"


def test_build_index_and_remote_query_keep_exact_source_offsets(
    source_path: Path, tmp_path: Path
) -> None:
    index_path = tmp_path / "task-index.json"
    built = _run(
        "build-index",
        "--source",
        str(source_path),
        "--start-line",
        "5",
        "--end-line",
        "14",
        "--tail-before-start",
        "1",
        "--output",
        str(index_path),
    )

    assert built["status"] == "indexed"
    index = json.loads(index_path.read_text(encoding="utf-8"))
    assert all(72 <= p["chapter_number"] <= 76 for p in index["passages"])
    assert any(p["selection_role"] == "prelude" for p in index["passages"])
    assert not any(p["chapter_number"] == 77 for p in index["passages"])

    # The receiving side can query from elsewhere after the original has been
    # removed; only the index is needed to produce the citation.
    original_lines = source_path.read_bytes().decode("gb18030").splitlines()
    source_path.unlink()
    result = _run(
        "query",
        "--index",
        str(index_path),
        "--query",
        "龙纛立起来一刻钟后",
        cwd=tmp_path,
    )
    assert result["status"] == "found"
    quote = next(item for item in result["results"] if item["chapter_number"] == 76)
    assert original_lines[quote["physical_line"] - 1][quote["char_start"] : quote["char_end"]] == quote["quote"]
    assert quote["chapter_number"] == 76
    assert Path(quote["source_file"]).name == source_path.name


def test_prelude_is_last_paragraph_only_and_later_chapters_are_excluded(
    source_path: Path, tmp_path: Path
) -> None:
    index_path = tmp_path / "task-index.json"
    _run(
        "build-index",
        "--source",
        str(source_path),
        "--start-line",
        "5",
        "--end-line",
        "14",
        "--tail-before-start",
        "1",
        "--output",
        str(index_path),
    )

    early = _run("query", "--index", str(index_path), "--query", "较早的前情标记")
    assert early["status"] == "not_found"
    assert early["message"] == "现有引用未能印证"

    later_rain = _run("query", "--index", str(index_path), "--query", "夏雨滂沱")
    assert later_rain["status"] == "not_found"


def test_build_index_can_select_only_target_paragraph_within_one_chapter(
    tmp_path: Path,
) -> None:
    source_path = tmp_path / "single-line-chapter.txt"
    source_path.write_bytes(
        (
            "第十章 商旅\n"
            "    同章前情标记：商队在节庆前整装。"
            "    目标场景标记：商人把香料交给下一位旅人。"
            "    同章后续回忆标记：十年后他仍记得这次交易。\n"
        ).encode("gb18030")
    )
    index_path = tmp_path / "target-only.json"
    built = _run(
        "build-index",
        "--source",
        str(source_path),
        "--start-line",
        "1",
        "--end-line",
        "1",
        "--start-paragraph",
        "2",
        "--end-paragraph",
        "2",
        "--output",
        str(index_path),
    )

    assert built["paragraph_units"] == 1
    index = json.loads(index_path.read_text(encoding="utf-8"))
    assert index["selection"]["start_paragraph"] == 2
    assert index["selection"]["end_paragraph"] == 2
    assert [passage["paragraph_index"] for passage in index["passages"]] == [2]

    target = _run("query", "--index", str(index_path), "--query", "交给下一位旅人")
    earlier = _run("query", "--index", str(index_path), "--query", "节庆前整装")
    later = _run("query", "--index", str(index_path), "--query", "十年后仍记得")
    assert target["status"] == "found"
    assert earlier["status"] == "not_found"
    assert later["status"] == "not_found"


def test_partial_paragraph_bounds_must_be_paired(source_path: Path, tmp_path: Path) -> None:
    result = subprocess.run(
        [
            sys.executable,
            str(PROGRAM),
            "build-index",
            "--source",
            str(source_path),
            "--start-line",
            "5",
            "--end-line",
            "14",
            "--start-paragraph",
            "2",
            "--output",
            str(tmp_path / "bad-index.json"),
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 2
    assert "必须同时提供" in result.stderr


@pytest.mark.parametrize(
    ("start_paragraph", "end_paragraph", "expected_message"),
    [
        (3, 1, "起始章节没有第3个正文段落"),
        (1, 3, "结束章节没有第3个正文段落"),
    ],
)
def test_partial_range_rejects_out_of_bounds_endpoint_in_each_chapter(
    tmp_path: Path,
    start_paragraph: int,
    end_paragraph: int,
    expected_message: str,
) -> None:
    source_path = tmp_path / "two-chapter-book.txt"
    source_path.write_bytes(
        (
            "第一章 起点\n"
            "    起始章第一段。    起始章第二段。\n"
            "第二章 终点\n"
            "    结束章第一段。    结束章第二段。\n"
        ).encode("gb18030")
    )
    result = subprocess.run(
        [
            sys.executable,
            str(PROGRAM),
            "build-index",
            "--source",
            str(source_path),
            "--start-line",
            "1",
            "--end-line",
            "3",
            "--start-paragraph",
            str(start_paragraph),
            "--end-paragraph",
            str(end_paragraph),
            "--output",
            str(tmp_path / "bad-range.json"),
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 2
    assert expected_message in result.stderr


def test_partial_multi_condition_is_candidate_not_evidence(
    source_path: Path, tmp_path: Path
) -> None:
    index_path = tmp_path / "task-index.json"
    _run(
        "build-index",
        "--source",
        str(source_path),
        "--start-line",
        "5",
        "--end-line",
        "14",
        "--output",
        str(index_path),
    )

    result = _run(
        "query",
        "--index",
        str(index_path),
        "--query",
        "记得有一段写龙纛和突如其来的大雨",
    )
    assert result["status"] == "candidate"
    assert "尚不能印证" in result["message"]
    assert result["results"]
    assert all("龙纛" in item["quote"] for item in result["results"])


def test_terms_in_separate_passages_are_not_reported_as_found(
    source_path: Path, tmp_path: Path
) -> None:
    index_path = tmp_path / "task-index.json"
    _run(
        "build-index",
        "--source",
        str(source_path),
        "--start-line",
        "5",
        "--end-line",
        "14",
        "--output",
        str(index_path),
    )

    result = _run(
        "query",
        "--index",
        str(index_path),
        "--query",
        "龙纛和阳光微微偏西",
    )
    assert result["status"] == "candidate"
    assert "各条件之间有直接关系" in result["coverage_note"]


def test_broad_source_search_returns_a_citation_and_unrelated_query_misses(
    source_path: Path,
) -> None:
    hit = _run("search", "--source", str(source_path), "--query", "龙纛")
    assert hit["status"] == "found"
    assert hit["results"]
    assert all(item["physical_line"] > 0 for item in hit["results"])

    miss = _run(
        "search",
        "--source",
        str(source_path),
        "--query",
        "宇航员驾驶飞船登陆月球",
    )
    assert miss["status"] == "not_found"
    assert miss["message"] == "现有引用未能印证"


def test_build_requires_real_heading_line(source_path: Path, tmp_path: Path) -> None:
    result = subprocess.run(
        [
            sys.executable,
            str(PROGRAM),
            "build-index",
            "--source",
            str(source_path),
            "--start-line",
            "6",
            "--end-line",
            "14",
            "--output",
            str(tmp_path / "bad-index.json"),
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 2
    assert "实际的章节标题行" in result.stderr
