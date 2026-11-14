#!/usr/bin/env python3
"""Create and query position-preserving, task-specific text indexes."""

from __future__ import annotations

import argparse
import json
import math
import re
import shutil
import sys
from collections import Counter
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Iterable


INDEX_VERSION = 1
DEFAULT_ENCODING = "gb18030"
NOT_FOUND_MESSAGE = "现有引用未能印证"
CANDIDATE_MESSAGE = "以下为关键词候选，尚不能印证问题中的全部条件"
CHAPTER_HEADING = re.compile(
    r"^\s*第?([零〇一二三四五六七八九十百千]+)章\s*(.*?)\s*$"
)
PARAGRAPH_GAP = re.compile(r" {2,}")
SENTENCE_END = re.compile(r"[。！？!?；]")
POSTSCRIPT = re.compile(r"^\s*PS\s*[:：]", re.IGNORECASE)
CHINESE_RUN = re.compile(r"[\u3400-\u9fff]+")
LATIN_RUN = re.compile(r"[a-z0-9]+", re.IGNORECASE)
QUERY_SPLIT = re.compile(r"[，,。！？?；;、和与及]")
QUERY_NOISE = (
    "我记得有一段",
    "有没有一段",
    "我想知道",
    "我想问",
    "请问",
    "有一段",
    "原文里",
    "原著里",
    "小说里",
    "描写的是",
    "写的是",
    "写到",
    "写",
    "描写",
    "描述",
    "标记",
    "关于",
    "记得",
    "帮我",
    "告诉我",
    "能不能",
    "能否",
    "有没有",
    "是否",
    "还是",
)
QUERY_GENERIC_BIGRAMS = {
    "举起",
    "立起",
    "升起",
    "起来",
    "已经",
    "发生",
    "刻已",
    "经发",
    "之后",
    "之前",
    "有人",
    "先有",
    "这一",
    "什么",
    "变化",
    "时候",
    "标记",
}
QUERY_NOISE_CHARS = str.maketrans(
    {character: " " for character in "的了和与及呢吗啊吧呀"}
)
MAX_SENTENCE_CHUNK = 700
MAX_QUOTE_LENGTH = 220
PACKAGE_START = "<!-- auto-generated retrieval-package:start -->"
PACKAGE_END = "<!-- auto-generated retrieval-package:end -->"


@dataclass(frozen=True)
class Heading:
    number: int
    title: str
    physical_line: int


@dataclass(frozen=True)
class Passage:
    chapter_number: int | None
    chapter_title: str | None
    source_file: str
    physical_line: int
    paragraph_index: int
    char_start: int
    char_end: int
    text: str
    selection_role: str = "body"


def chinese_number(value: str) -> int:
    """Convert the Chinese chapter numbers used in common TXT novels."""
    digits = {
        "零": 0,
        "〇": 0,
        "一": 1,
        "二": 2,
        "三": 3,
        "四": 4,
        "五": 5,
        "六": 6,
        "七": 7,
        "八": 8,
        "九": 9,
    }
    units = {"十": 10, "百": 100, "千": 1000}
    total = current = 0
    for character in value:
        if character in digits:
            current = digits[character]
        else:
            total += (current or 1) * units[character]
            current = 0
    return total + current


def read_source(path: str | Path, encoding: str = DEFAULT_ENCODING) -> tuple[str, list[str]]:
    source_path = Path(path).expanduser().resolve()
    text = source_path.read_bytes().decode(encoding)
    return str(source_path), text.splitlines()


def find_headings(lines: list[str]) -> list[Heading]:
    headings: list[Heading] = []
    for index, line in enumerate(lines):
        match = CHAPTER_HEADING.match(line)
        if match:
            headings.append(
                Heading(
                    number=chinese_number(match.group(1)),
                    title=match.group(2).strip(),
                    physical_line=index + 1,
                )
            )
    return headings


def _paragraphs(line: str) -> Iterable[tuple[str, int, int]]:
    """Yield natural paragraphs and exact character offsets within a line."""
    cursor = len(line) - len(line.lstrip(" "))
    if cursor >= len(line):
        return
    for gap in PARAGRAPH_GAP.finditer(line, cursor):
        if gap.start() > cursor:
            end = gap.start()
            while end > cursor and line[end - 1].isspace():
                end -= 1
            if end > cursor:
                yield line[cursor:end], cursor, end
        cursor = gap.end()
    end = len(line.rstrip())
    if end > cursor:
        yield line[cursor:end], cursor, end


def _split_long_paragraph(text: str, start: int, end: int) -> Iterable[tuple[str, int, int]]:
    if len(text) <= MAX_SENTENCE_CHUNK:
        yield text, start, end
        return
    spans: list[tuple[int, int]] = []
    cursor = 0
    for match in SENTENCE_END.finditer(text):
        spans.append((cursor, match.end()))
        cursor = match.end()
    if cursor < len(text):
        spans.append((cursor, len(text)))
    if len(spans) < 2:
        yield text, start, end
        return

    group_start, group_end = spans[0]
    for sentence_start, sentence_end in spans[1:]:
        if sentence_end - group_start > MAX_SENTENCE_CHUNK:
            piece = text[group_start:group_end]
            left = group_start + len(piece) - len(piece.lstrip())
            right = group_end - (len(piece) - len(piece.rstrip()))
            if right > left:
                yield text[left:right], start + left, start + right
            group_start, group_end = sentence_start, sentence_end
        else:
            group_end = sentence_end
    piece = text[group_start:group_end]
    left = group_start + len(piece) - len(piece.lstrip())
    right = group_end - (len(piece) - len(piece.rstrip()))
    if right > left:
        yield text[left:right], start + left, start + right


def _all_passages(
    lines: list[str], source_file: str
) -> list[Passage]:
    headings = find_headings(lines)
    heading_by_line = {heading.physical_line: heading for heading in headings}
    passages: list[Passage] = []
    current_heading: Heading | None = None
    current_paragraph_index = 0
    preface_paragraph_index = 0

    for physical_line, line in enumerate(lines, 1):
        if physical_line in heading_by_line:
            current_heading = heading_by_line[physical_line]
            current_paragraph_index = 0
            continue
        if not line.strip():
            continue
        for paragraph, char_start, char_end in _paragraphs(line):
            if POSTSCRIPT.match(paragraph):
                break
            number = current_heading.number if current_heading else None
            if current_heading:
                current_paragraph_index += 1
                paragraph_index = current_paragraph_index
            else:
                preface_paragraph_index += 1
                paragraph_index = preface_paragraph_index
            for piece, piece_start, piece_end in _split_long_paragraph(
                paragraph, char_start, char_end
            ):
                passages.append(
                    Passage(
                        chapter_number=number,
                        chapter_title=current_heading.title if current_heading else None,
                        source_file=source_file,
                        physical_line=physical_line,
                        paragraph_index=paragraph_index,
                        char_start=piece_start,
                        char_end=piece_end,
                        text=piece,
                    )
                )
    return passages


def _chapter_passages(
    lines: list[str],
    source_file: str,
    heading: Heading,
    next_heading: Heading | None,
    role: str = "body",
    tail_paragraphs: int | None = None,
) -> list[Passage]:
    stop_line = next_heading.physical_line if next_heading else len(lines) + 1
    natural_paragraphs: list[Passage] = []
    paragraph_index = 0
    for physical_line in range(heading.physical_line + 1, stop_line):
        line = lines[physical_line - 1]
        for paragraph, char_start, char_end in _paragraphs(line):
            if POSTSCRIPT.match(paragraph):
                break
            paragraph_index += 1
            natural_paragraphs.append(
                Passage(
                    chapter_number=heading.number,
                    chapter_title=heading.title,
                    source_file=source_file,
                    physical_line=physical_line,
                    paragraph_index=paragraph_index,
                    char_start=char_start,
                    char_end=char_end,
                    text=paragraph,
                    selection_role=role,
                )
            )
    if tail_paragraphs is not None:
        natural_paragraphs = natural_paragraphs[-tail_paragraphs:]

    chapter_passages: list[Passage] = []
    for passage in natural_paragraphs:
        for piece, piece_start, piece_end in _split_long_paragraph(
            passage.text, passage.char_start, passage.char_end
        ):
            chapter_passages.append(
                Passage(
                    chapter_number=passage.chapter_number,
                    chapter_title=passage.chapter_title,
                    source_file=passage.source_file,
                    physical_line=passage.physical_line,
                    paragraph_index=passage.paragraph_index,
                    char_start=piece_start,
                    char_end=piece_end,
                    text=piece,
                    selection_role=role,
                )
            )
    return chapter_passages


def _query_groups(question: str) -> list[str]:
    cleaned = question.strip().lower()
    for phrase in sorted(QUERY_NOISE, key=len, reverse=True):
        cleaned = cleaned.replace(phrase, " ")
    groups: list[str] = []
    for fragment in QUERY_SPLIT.split(cleaned):
        fragment = fragment.translate(QUERY_NOISE_CHARS)
        for run in CHINESE_RUN.findall(fragment):
            groups.extend(
                part[1:] if part.startswith("是") and len(part) > 2 else part
                for part in run.split()
                if part
            )
        groups.extend(LATIN_RUN.findall(fragment))
    return groups


def _bigram_terms(value: str) -> set[str]:
    if LATIN_RUN.fullmatch(value):
        return {value.lower()}
    return {
        value[index : index + 2]
        for index in range(len(value) - 1)
        if value[index : index + 2] not in QUERY_GENERIC_BIGRAMS
    }


def _passage_terms(value: str) -> set[str]:
    terms: set[str] = set()
    for run in CHINESE_RUN.findall(value.lower()):
        terms.update(run[index : index + 2] for index in range(len(run) - 1))
    terms.update(LATIN_RUN.findall(value.lower()))
    return terms


def _normal_text(value: str) -> str:
    return re.sub(r"[\s，,。！？?；;、：:“”‘’'\"—…()（）]", "", value).lower()


def _query_passages(
    passages: list[Passage], question: str, limit: int, context: dict[str, object]
) -> dict[str, object]:
    question = question.strip()
    if not question:
        raise ValueError("查询内容不能为空。")
    if limit < 1:
        raise ValueError("limit 必须大于等于1。")
    groups = _query_groups(question)
    if not groups:
        return _not_found(question, context)

    passage_terms = [_passage_terms(passage.text) for passage in passages]
    document_frequency: Counter[str] = Counter()
    for terms in passage_terms:
        document_frequency.update(terms)
    char_document_frequency: Counter[str] = Counter()
    for passage in passages:
        char_document_frequency.update(set(passage.text))

    indexed_groups: list[dict[str, object]] = []
    for group in groups:
        terms = _bigram_terms(group)
        exact = len(group) >= 2
        # A single rain character is useful as a cautious candidate for a
        # longer weather phrase such as “突如其来的大雨”. It never proves the
        # user's full wording by itself.
        rain_char = "雨" if "雨" in group else None
        indexed_groups.append(
            {"text": group, "terms": terms, "exact": exact, "rain_char": rain_char}
        )

    direct_question = _normal_text(question)
    scored: list[
        tuple[bool, float, int, Passage, list[str], set[str], set[int], set[int]]
    ] = []

    for passage_index, (passage, terms) in enumerate(zip(passages, passage_terms)):
        matched_groups: list[str] = []
        matched_terms: set[str] = set()
        matched_group_indexes: set[int] = set()
        exact_group_indexes: set[int] = set()
        group_score = 0.0
        exact_passage = _normal_text(passage.text)
        exact_here = bool(direct_question and direct_question in exact_passage)
        for group_index, group in enumerate(indexed_groups):
            group_text = str(group["text"])
            group_terms = group["terms"]
            assert isinstance(group_terms, set)
            matched = group_terms & terms
            full_phrase = len(group_text) >= 2 and _normal_text(group_text) in exact_passage
            if full_phrase:
                matched_group_indexes.add(group_index)
                exact_group_indexes.add(group_index)
                exact_here = True
                matched_groups.append(group_text)
                matched_terms.update(matched)
                group_score = max(group_score, 1.0)
                continue

            coverage_ratio = len(matched) / max(1, len(group_terms))
            strong_matches = {
                term
                for term in matched
                if document_frequency[term] <= max(3, len(passages) // 100)
            }
            rain_char = group["rain_char"]
            rain_hit = bool(
                rain_char
                and char_document_frequency[rain_char] <= max(8, len(passages) // 40)
                and rain_char in passage.text
            )
            if rain_hit:
                strong_matches.add(rain_char)
            if coverage_ratio >= 0.5:
                strong_matches = matched
            if not strong_matches or (coverage_ratio < 0.5 and not rain_hit):
                continue
            matched_group_indexes.add(group_index)
            matched_groups.append(group_text)
            matched_terms.update(strong_matches)
            weights = {
                term: math.log(
                    (len(passages) + 1) / (document_frequency[term] + 0.5)
                )
                + 1
                for term in strong_matches
                if term in document_frequency
            }
            group_score = max(group_score, sum(weights.values()) or 0.25)

        if matched_terms:
            group_score += max(0, len(matched_group_indexes) - 1) * 2.0
            scored.append(
                (
                    exact_here,
                    group_score,
                    passage_index,
                    passage,
                    matched_groups,
                    matched_terms,
                    matched_group_indexes,
                    exact_group_indexes,
                )
            )

    if len(indexed_groups) > 1 and scored:
        primary_chapters = {
            item[3].chapter_number for item in scored if 0 in item[6]
        }
        scored = [item for item in scored if item[3].chapter_number in primary_chapters]
    if not scored:
        return _not_found(question, context)

    group_hits = set().union(*(item[6] for item in scored))
    exact_group_hits = set().union(*(item[7] for item in scored))

    scored.sort(key=lambda item: (not item[0], -item[1], item[2]))
    chosen = scored[:limit]
    chosen.sort(key=lambda item: item[2])
    results = [
        _citation(passage, score, matched_groups, matched_terms)
        for _, score, _, passage, matched_groups, matched_terms, _, _ in chosen
    ]

    exact_question_found = any(
        direct_question and direct_question in _normal_text(passage.text)
        for _, _, _, passage, _, _, _, _ in chosen
    )
    all_groups_same_passage = any(
        len(item[7]) == len(indexed_groups) for item in scored
    )
    one_group_exact = len(indexed_groups) == 1 and bool(exact_group_hits)
    status = (
        "found"
        if exact_question_found or all_groups_same_passage or one_group_exact
        else "candidate"
    )
    response: dict[str, object] = {
        "status": status,
        "question": question,
        "scope": context,
        "coverage": {
            "matched_groups": [
                str(group["text"])
                for index, group in enumerate(indexed_groups)
                if index in group_hits
            ],
            "unmatched_groups": [
                str(group["text"])
                for index, group in enumerate(indexed_groups)
                if index not in group_hits
            ],
        },
        "results": results,
    }
    if status == "candidate":
        response["message"] = CANDIDATE_MESSAGE
        response["coverage_note"] = (
            "词组命中可能分散在不同段落；候选不代表各条件之间有直接关系。"
        )
    return response


def _citation(
    passage: Passage,
    score: float,
    matched_groups: list[str],
    matched_terms: set[str],
) -> dict[str, object]:
    start = passage.char_start
    quote = passage.text
    truncated = False
    if len(quote) > MAX_QUOTE_LENGTH:
        positions = [quote.find(term) for term in matched_terms if len(term) > 1]
        anchor = min((position for position in positions if position >= 0), default=0)
        local_start = max(0, min(anchor - MAX_QUOTE_LENGTH // 3, len(quote) - MAX_QUOTE_LENGTH))
        quote = quote[local_start : local_start + MAX_QUOTE_LENGTH]
        start += local_start
        truncated = True
    return {
        "chapter_number": passage.chapter_number,
        "chapter_title": passage.chapter_title,
        "source_file": passage.source_file,
        "physical_line": passage.physical_line,
        "paragraph_index": passage.paragraph_index,
        "char_start": start,
        "char_end": start + len(quote),
        "quote": quote,
        "truncated": truncated,
        "score": round(score, 4),
        "matched_groups": matched_groups,
        "matched_terms": sorted(matched_terms, key=lambda term: (-len(term), term))[:8],
        "selection_role": passage.selection_role,
    }


def _not_found(question: str, context: dict[str, object]) -> dict[str, object]:
    return {
        "status": "not_found",
        "question": question,
        "message": NOT_FOUND_MESSAGE,
        "scope": context,
        "coverage": {"matched_groups": [], "unmatched_groups": _query_groups(question)},
        "results": [],
    }


def _portable_source_name(value: object) -> str:
    """Keep a source label without carrying a machine-specific path."""
    return str(value).replace("\\", "/").rsplit("/", 1)[-1] or "原始资料"


def _remove_previous_package_note(text: str) -> str:
    pattern = re.compile(
        rf"(?m)^{re.escape(PACKAGE_START)}\n.*?^{re.escape(PACKAGE_END)}(?:\n|$)",
        re.DOTALL,
    )
    return pattern.sub("", text).rstrip()


def _rewrite_reference_line(line: str, has_index: bool) -> str:
    """Keep creator context while replacing references that cannot travel."""
    index_replacement = "资料索引.json" if has_index else "资料索引.json（本包未附）"
    script_replacement = (
        "scene_retrieval.py"
        if has_index
        else "scene_retrieval.py（本包未附查询程序）"
    )
    segment = r"[^\s`<>()（）\[\],，;；:：/\\]+"
    for filename, replacement in (
        ("资料索引.json", index_replacement),
        ("scene_retrieval.py", script_replacement),
    ):
        escaped = re.escape(filename)
        absolute_path = re.compile(
            rf"(?<![\w.-])(?:[A-Za-z]:)?[/\\](?:{segment}[/\\])*{escaped}"
        )
        relative_path = re.compile(
            rf"(?<![\w./\\-])(?:\.{{1,2}}[/\\]|{segment}[/\\])"
            rf"(?:{segment}[/\\])*{escaped}"
        )
        for path_pattern in (absolute_path, relative_path):
            line = path_pattern.sub(replacement, line)

    if not has_index:
        line = re.sub(
            r"(?<![\w/\\])资料索引\.json(?!（本包未附）)",
            index_replacement,
            line,
        )
        line = re.sub(
            r"(?<![\w/\\])scene_retrieval\.py(?!（本包未附查询程序）)",
            script_replacement,
            line,
        )

    return line


def _clean_reference_section(text: str, has_index: bool) -> str:
    lines = _remove_previous_package_note(text).splitlines()
    in_references = False
    cleaned: list[str] = []
    for line in lines:
        if re.match(r"^#{1,6}\s+", line):
            in_references = bool(re.match(r"^#{1,6}\s*参考资料", line))
        cleaned.append(_rewrite_reference_line(line, has_index) if in_references else line)
    return "\n".join(cleaned).rstrip()


def _package_note(task_index: dict | None) -> str:
    if task_index is None:
        body = (
            "## 本地引用查询\n\n"
            "本包未附场面引用索引，因此没有可在包内运行的查询命令；"
            "这不表示原文中不存在相关内容。"
        )
    else:
        chapters = task_index["selection"].get("chapters", [])
        chapter_names = "、".join(str(chapter["title"]) for chapter in chapters)
        prelude_count = sum(1 for passage in task_index["passages"] if passage.get("selection_role") == "prelude")
        scope = f"本次索引章节：{chapter_names}；另含前置衔接 {prelude_count} 段。\n\n" if chapter_names else ""
        body = (
            "## 本地引用查询\n\n"
            + scope
            + "本包内的任务索引：[`资料索引.json`](./资料索引.json)。"
            "查询程序：[`scene_retrieval.py`](./scene_retrieval.py)。\n\n"
            "索引只包含本次筛选的段落，不包含整本原文；来源路径仅保留原文件名。\n\n"
            "在本包目录运行以下命令，并将问题文字替换为要核实的问题：\n\n"
            "```sh\n"
            "python3 ./scene_retrieval.py query --index './资料索引.json' "
            "--query '请替换为待核实的问题'\n"
            "```\n\n"
            "结果状态说明：\n\n"
            "- `found`：完整问题短语或全部查询词组在同一段原文中命中；"
            "结果提供引用，仍需结合上下文判断。\n"
            "- `candidate`：只命中部分线索，不能作为问题已获印证的答案。\n"
            "- `not_found`：当前任务索引没有找到依据，不代表未收录的其他章节也没有。"
        )
    return f"{PACKAGE_START}\n{body}\n{PACKAGE_END}"


def package_task(
    requirements_path: Path, index_path: Path | None, output_path: Path
) -> dict[str, object]:
    requirements_path = requirements_path.expanduser().resolve()
    output_path = output_path.expanduser().resolve()
    if not requirements_path.is_file():
        raise ValueError(f"找不到视频需求文档：{requirements_path}")
    if index_path is not None:
        index_path = index_path.expanduser().resolve()
        if not index_path.is_file():
            raise ValueError(f"找不到任务索引：{index_path}")
        task_index = json.loads(index_path.read_text(encoding="utf-8"))
        if not isinstance(task_index, dict):
            raise ValueError("任务索引必须是JSON对象。")
        if task_index.get("index_version") != INDEX_VERSION:
            raise ValueError("索引版本不受支持。")
        passages = task_index.get("passages")
        if not isinstance(passages, list) or not passages:
            raise ValueError("任务索引缺少可查询的选段。")
        for item in passages:
            Passage(**item)
        if "source_file" not in task_index or "selection" not in task_index:
            raise ValueError("任务索引缺少来源或选段信息。")

    requirement_text = requirements_path.read_text(encoding="utf-8")
    if index_path is not None:
        source_name = str(task_index["source_file"])
        requirement_text = requirement_text.replace(source_name, _portable_source_name(source_name))
    requirement_text = _clean_reference_section(
        requirement_text, has_index=index_path is not None
    )
    note = _package_note(task_index if index_path is not None else None)
    packaged_requirement = f"{requirement_text}\n\n{note}\n"

    output_path.mkdir(parents=True, exist_ok=False)
    (output_path / "视频需求.md").write_text(packaged_requirement, encoding="utf-8")
    files = ["视频需求.md"]
    if index_path is not None:
        portable_index = dict(task_index)
        portable_index["source_file"] = _portable_source_name(task_index["source_file"])
        portable_index["passages"] = [
            {**passage, "source_file": _portable_source_name(passage["source_file"])}
            for passage in task_index["passages"]
        ]
        (output_path / "资料索引.json").write_text(
            json.dumps(portable_index, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        shutil.copyfile(Path(__file__).resolve(), output_path / "scene_retrieval.py")
        files.extend(("资料索引.json", "scene_retrieval.py"))
    return {"status": "packaged", "package_dir": str(output_path), "files": files}


def inspect_source(source_file: str, lines: list[str]) -> dict[str, object]:
    headings = find_headings(lines)
    return {
        "source_file": source_file,
        "physical_line_count": len(lines),
        "chapters": [asdict(heading) for heading in headings],
        "selection_note": "start_line/end_line 使用章节标题的物理行号，可避免重复章号产生歧义。",
    }


def build_task_index(
    lines: list[str],
    source_file: str,
    encoding: str,
    start_line: int,
    end_line: int,
    tail_before_start: int = 0,
    start_paragraph: int | None = None,
    end_paragraph: int | None = None,
) -> dict[str, object]:
    if tail_before_start < 0:
        raise ValueError("tail-before-start 不能小于0。")
    if (start_paragraph is None) != (end_paragraph is None):
        raise ValueError("start-paragraph 和 end-paragraph 必须同时提供。")
    if start_paragraph is not None and (start_paragraph < 1 or end_paragraph < 1):
        raise ValueError("段落编号从1开始。")
    headings = find_headings(lines)
    by_line = {heading.physical_line: index for index, heading in enumerate(headings)}
    if start_line not in by_line or end_line not in by_line:
        raise ValueError("start-line 和 end-line 必须是原文中实际的章节标题行。")
    start_index = by_line[start_line]
    end_index = by_line[end_line]
    if end_index < start_index:
        raise ValueError("end-line 必须位于 start-line 之后或与其相同。")
    if (
        start_paragraph is not None
        and start_index == end_index
        and end_paragraph < start_paragraph
    ):
        raise ValueError("同一章节的 end-paragraph 必须不小于 start-paragraph。")

    selected: list[Passage] = []
    if tail_before_start:
        if start_index == 0:
            raise ValueError("起始章节前没有可供截取的章节。")
        previous = headings[start_index - 1]
        selected.extend(
            _chapter_passages(
                lines,
                source_file,
                previous,
                headings[start_index],
                role="prelude",
                tail_paragraphs=tail_before_start,
            )
        )
    for index in range(start_index, end_index + 1):
        heading = headings[index]
        next_heading = headings[index + 1] if index + 1 < len(headings) else None
        chapter_passages = _chapter_passages(
            lines, source_file, heading, next_heading, role="body"
        )
        if start_paragraph is not None:
            assert end_paragraph is not None
            available_paragraphs = {
                passage.paragraph_index for passage in chapter_passages
            }
            if index == start_index and start_paragraph not in available_paragraphs:
                raise ValueError(
                    f"起始章节没有第{start_paragraph}个正文段落。"
                )
            if index == end_index and end_paragraph not in available_paragraphs:
                raise ValueError(f"结束章节没有第{end_paragraph}个正文段落。")
            first_paragraph = start_paragraph if index == start_index else 1
            last_paragraph = (
                end_paragraph if index == end_index else None
            )
            chapter_passages = [
                passage
                for passage in chapter_passages
                if passage.paragraph_index >= first_paragraph
                and (last_paragraph is None or passage.paragraph_index <= last_paragraph)
            ]
        selected.extend(chapter_passages)
    if not selected:
        raise ValueError("所选范围内没有可索引的正文段落；请核对章节和段落编号。")

    selected_headings = headings[start_index : end_index + 1]
    if tail_before_start:
        selected_headings = [headings[start_index - 1], *selected_headings]
    return {
        "index_version": INDEX_VERSION,
        "source_file": source_file,
        "source_encoding": encoding,
        "selection": {
            "start_line": start_line,
            "end_line": end_line,
            "tail_before_start_paragraphs": tail_before_start,
            "start_paragraph": start_paragraph,
            "end_paragraph": end_paragraph,
            "chapters": [asdict(heading) for heading in selected_headings],
        },
        "position_note": "physical_line 为1起始；char_start/char_end 是GB18030解码后的物理行内0起始、右开字符范围。",
        "passages": [asdict(passage) for passage in selected],
    }


def _dump(value: object) -> None:
    json.dump(value, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="探索原文、按选定章节生成任务索引，并对索引做只读引用查询。"
    )
    commands = parser.add_subparsers(dest="command", required=True)

    inspect_parser = commands.add_parser("inspect", help="列出原文中的章节标题和行号")
    inspect_parser.add_argument("--source", required=True, type=Path)
    inspect_parser.add_argument("--encoding", default=DEFAULT_ENCODING)

    search_parser = commands.add_parser("search", help="在全书中找章节和原文候选")
    search_parser.add_argument("--source", required=True, type=Path)
    search_parser.add_argument("--encoding", default=DEFAULT_ENCODING)
    search_parser.add_argument("--query", required=True)
    search_parser.add_argument("--limit", type=int, default=5)

    build_parser = commands.add_parser(
        "build-index", help="按章节及可选自然段范围导出本次任务的选段索引"
    )
    build_parser.add_argument("--source", required=True, type=Path)
    build_parser.add_argument("--encoding", default=DEFAULT_ENCODING)
    build_parser.add_argument("--start-line", required=True, type=int)
    build_parser.add_argument("--end-line", required=True, type=int)
    build_parser.add_argument(
        "--start-paragraph",
        type=int,
        help="起始章节内从此自然段开始（与 --end-paragraph 配对使用）",
    )
    build_parser.add_argument(
        "--end-paragraph",
        type=int,
        help="结束章节内到此自然段结束（与 --start-paragraph 配对使用）",
    )
    build_parser.add_argument("--tail-before-start", type=int, default=0)
    build_parser.add_argument("--output", required=True, type=Path)

    query_parser = commands.add_parser("query", help="只读查询已导出的任务索引")
    query_parser.add_argument("--index", required=True, type=Path)
    query_parser.add_argument("--query", required=True)
    query_parser.add_argument("--limit", type=int, default=3)

    package_parser = commands.add_parser(
        "package", help="把需求文档、可选任务索引和查询工具整理为可移动交接包"
    )
    package_parser.add_argument("--requirements", required=True, type=Path)
    package_parser.add_argument("--index", type=Path)
    package_parser.add_argument("--output", required=True, type=Path)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = _parser()
    args = parser.parse_args(argv)
    try:
        if args.command == "query":
            task_index = json.loads(args.index.expanduser().read_text(encoding="utf-8"))
            if task_index.get("index_version") != INDEX_VERSION:
                raise ValueError("索引版本不受支持。")
            passages = [Passage(**item) for item in task_index.get("passages", [])]
            context = {
                "type": "task_index",
                "index_file": str(args.index.expanduser().resolve()),
                "source_file": task_index["source_file"],
                "selection": task_index["selection"],
            }
            _dump(_query_passages(passages, args.query, args.limit, context))
            return 0

        if args.command == "package":
            _dump(package_task(args.requirements, args.index, args.output))
            return 0

        source_file, lines = read_source(args.source, args.encoding)
        if args.command == "inspect":
            _dump(inspect_source(source_file, lines))
            return 0

        if args.command == "search":
            passages = _all_passages(lines, source_file)
            context = {"type": "source_search", "source_file": source_file}
            _dump(_query_passages(passages, args.query, args.limit, context))
            return 0

        task_index = build_task_index(
            lines,
            source_file,
            args.encoding,
            args.start_line,
            args.end_line,
            args.tail_before_start,
            args.start_paragraph,
            args.end_paragraph,
        )
        output_path = args.output.expanduser().resolve()
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(
            json.dumps(task_index, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        _dump(
            {
                "status": "indexed",
                "index_file": str(output_path),
                "source_file": source_file,
                "paragraph_units": len(task_index["passages"]),
                "selection": task_index["selection"],
            }
        )
        return 0
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError, TypeError) as error:
        parser.exit(2, f"错误：{error}\n")


if __name__ == "__main__":
    raise SystemExit(main())
