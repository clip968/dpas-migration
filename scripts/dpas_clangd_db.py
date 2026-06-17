#!/usr/bin/env python3
"""Generate a small clangd compile database for touched DPAS kernel files."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path


CMD_LINE_RE = re.compile(
    r"^(?:saved)?cmd_[^ ]*\.o := (?P<command_prefix>.* )(?P<file_path>[^ ]*\.[cS]) *(?:;|$)"
)
TRANSLATION_UNIT_SUFFIXES = {".c", ".S"}
HEADER_SUFFIXES = {".h"}
PREFERRED_HEADER_DONORS = [
    "block/blk-mq.c",
    "block/blk-core.c",
    "block/blk-sysfs.c",
    "block/blk-stat.c",
]


def run_git(kernel_dir: Path, args: list[str]) -> str:
    result = subprocess.run(
        ["git", *args],
        cwd=kernel_dir,
        check=True,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    return result.stdout


def default_history_base(kernel_dir: Path) -> str:
    roots = run_git(kernel_dir, ["rev-list", "--max-parents=0", "HEAD"]).splitlines()
    if not roots:
        raise RuntimeError("could not find the root commit for dpas-kernel")
    return roots[0]


def history_paths(kernel_dir: Path, base: str | None, head: str) -> list[str]:
    history_base = base or default_history_base(kernel_dir)
    output = run_git(kernel_dir, ["log", "--format=", "--name-only", f"{history_base}..{head}"])
    return [line.strip() for line in output.splitlines() if line.strip()]


def dirty_tracked_paths(kernel_dir: Path) -> list[str]:
    output = run_git(kernel_dir, ["status", "--porcelain", "--untracked-files=no"])
    paths: list[str] = []
    for line in output.splitlines():
        if not line:
            continue
        # Porcelain v1 path starts at column 4. Rename lines use "old -> new".
        path = line[3:].strip()
        if " -> " in path:
            path = path.rsplit(" -> ", 1)[1]
        if path:
            paths.append(path)
    return paths


def normalize_source_arg(source_root: Path, path: str) -> str:
    candidate = Path(path)
    if candidate.is_absolute():
        try:
            return candidate.resolve().relative_to(source_root.resolve()).as_posix()
        except ValueError as exc:
            raise ValueError(f"{path} is outside {source_root}") from exc

    parts = candidate.parts
    if parts and parts[0] == source_root.name:
        return Path(*parts[1:]).as_posix()
    return candidate.as_posix()


def filter_translation_units(source_root: Path, paths: list[str]) -> list[str]:
    seen: set[str] = set()
    selected: list[str] = []
    for path in paths:
        rel = normalize_source_arg(source_root, path)
        if rel in seen:
            continue
        if Path(rel).suffix not in TRANSLATION_UNIT_SUFFIXES:
            continue
        if rel.startswith("tools/"):
            continue
        if not (source_root / rel).is_file():
            continue
        seen.add(rel)
        selected.append(rel)
    return selected


def filter_headers(source_root: Path, paths: list[str]) -> list[str]:
    seen: set[str] = set()
    selected: list[str] = []
    for path in paths:
        rel = normalize_source_arg(source_root, path)
        if rel in seen:
            continue
        if Path(rel).suffix not in HEADER_SUFFIXES:
            continue
        if rel.startswith("tools/"):
            continue
        if not (source_root / rel).is_file():
            continue
        seen.add(rel)
        selected.append(rel)
    return selected


def object_rel_for_source(source_rel: str) -> Path:
    return Path(source_rel).with_suffix(".o")


def cmd_file_for_source(build_root: Path, source_rel: str) -> Path:
    object_rel = object_rel_for_source(source_rel)
    return build_root / object_rel.parent / f".{object_rel.name}.cmd"


def host_path_from_cmd_path(path_text: str, source_root: Path, container_source: Path) -> Path:
    source_root = source_root.resolve()
    container_text = container_source.as_posix().rstrip("/")
    if path_text.startswith(container_text + "/"):
        suffix = path_text[len(container_text) + 1 :]
        return source_root / suffix
    path = Path(path_text)
    if path.is_absolute():
        return path
    return source_root / path


def rewrite_command(command: str, source_root: Path, build_root: Path, container_source: Path, container_build: Path) -> str:
    rewritten = command.replace(container_source.as_posix(), source_root.resolve().as_posix())
    rewritten = rewritten.replace(container_build.as_posix(), build_root.resolve().as_posix())
    return rewritten


def entry_from_cmd_file(
    cmd_file: Path,
    source_root: Path,
    build_root: Path,
    container_source: Path,
    container_build: Path,
) -> dict[str, str]:
    first_line = cmd_file.read_text().splitlines()[0]
    match = CMD_LINE_RE.match(first_line)
    if not match:
        raise ValueError(f"could not parse kbuild command from {cmd_file}")

    command_prefix = match.group("command_prefix").replace("$(pound)", "#")
    file_path = match.group("file_path")
    host_file = host_path_from_cmd_path(file_path, source_root, container_source).resolve()
    if not host_file.is_file():
        raise ValueError(f"{cmd_file} points at missing source file {host_file}")

    command = rewrite_command(
        command_prefix + file_path,
        source_root=source_root,
        build_root=build_root,
        container_source=container_source,
        container_build=container_build,
    )

    return {
        "directory": str(build_root.resolve()),
        "file": str(host_file),
        "command": command,
    }


def entries_for_sources(
    source_root: Path,
    build_root: Path,
    sources: list[str],
    container_source: Path,
    container_build: Path,
) -> tuple[list[dict[str, str]], list[tuple[str, Path]]]:
    entries: list[dict[str, str]] = []
    missing: list[tuple[str, Path]] = []
    for source in sources:
        cmd_file = cmd_file_for_source(build_root, source)
        if not cmd_file.is_file():
            missing.append((source, cmd_file))
            continue
        entries.append(
            entry_from_cmd_file(
                cmd_file=cmd_file,
                source_root=source_root,
                build_root=build_root,
                container_source=container_source,
                container_build=container_build,
            )
        )
    return entries, missing


def select_header_donor(header_rel: str, source_entries: dict[str, dict[str, str]]) -> dict[str, str]:
    header_path = Path(header_rel)
    matching_source = (header_path.parent / f"{header_path.stem}.c").as_posix()
    if matching_source in source_entries:
        return source_entries[matching_source]

    for source in PREFERRED_HEADER_DONORS:
        if source in source_entries:
            return source_entries[source]

    return next(iter(source_entries.values()))


def header_entry_from_source_entry(source_entry: dict[str, str], header_file: Path) -> dict[str, str]:
    source_file = source_entry["file"]
    header = str(header_file.resolve())
    if source_file not in source_entry["command"]:
        raise ValueError(f"source command does not contain its source file: {source_file}")
    command_prefix = source_entry["command"].rsplit(source_file, 1)[0]
    return {
        "directory": source_entry["directory"],
        "file": header,
        "command": f"{command_prefix}-x c-header {header}",
    }


def entries_for_headers(
    source_root: Path,
    headers: list[str],
    source_entries: dict[str, dict[str, str]],
) -> list[dict[str, str]]:
    if not headers:
        return []
    if not source_entries:
        raise ValueError("cannot create header entries without at least one source entry")

    entries: list[dict[str, str]] = []
    for header in headers:
        donor = select_header_donor(header, source_entries)
        entries.append(header_entry_from_source_entry(donor, source_root / header))
    return entries


def write_compile_commands(output: Path, entries: list[dict[str, str]]) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("w") as handle:
        json.dump(sorted(entries, key=lambda entry: entry["file"]), handle, indent=2, sort_keys=True)
        handle.write("\n")


def print_missing_help(missing: list[tuple[str, Path]]) -> None:
    targets = " ".join(object_rel_for_source(source).as_posix() for source, _ in missing)
    print("missing kbuild .cmd files for:", file=sys.stderr)
    for source, cmd_file in missing:
        print(f"  {source} -> {cmd_file}", file=sys.stderr)
    print("", file=sys.stderr)
    print("Build just those objects first, then rerun this command:", file=sys.stderr)
    print(f"  make -C /work/dpas-kernel O=/work/build/dpas-kernel-vm ARCH=x86 CROSS_COMPILE=x86_64-linux-gnu- {targets}", file=sys.stderr)


def parse_args(argv: list[str]) -> argparse.Namespace:
    repo_root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(
        description="Generate dpas-kernel/compile_commands.json for files touched in dpas-kernel git history."
    )
    parser.add_argument("files", nargs="*", help="optional source files to include instead of history-derived files")
    parser.add_argument("--source-root", type=Path, default=repo_root / "dpas-kernel")
    parser.add_argument("--build-root", type=Path, default=repo_root / "build/dpas-kernel-vm")
    parser.add_argument("--output", type=Path, default=repo_root / "dpas-kernel/compile_commands.json")
    parser.add_argument("--history-base", help="base commit; defaults to the root import commit")
    parser.add_argument("--history-head", default="HEAD")
    parser.add_argument("--container-source", type=Path, default=Path("/work/dpas-kernel"))
    parser.add_argument("--container-build", type=Path, default=Path("/work/build/dpas-kernel-vm"))
    parser.add_argument("--no-dirty", action="store_true", help="do not include currently modified tracked files")
    parser.add_argument("--print-files", action="store_true", help="print selected source files")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    source_root = args.source_root.resolve()
    build_root = args.build_root.resolve()

    if args.files:
        raw_paths = args.files
    else:
        raw_paths = history_paths(source_root, args.history_base, args.history_head)
        if not args.no_dirty:
            raw_paths.extend(dirty_tracked_paths(source_root))

    sources = filter_translation_units(source_root, raw_paths)
    headers = filter_headers(source_root, raw_paths)
    if not sources and not headers:
        print("no existing kernel .c/.S/.h files selected", file=sys.stderr)
        return 1

    entries, missing = entries_for_sources(
        source_root=source_root,
        build_root=build_root,
        sources=sources,
        container_source=args.container_source,
        container_build=args.container_build,
    )
    if missing:
        print_missing_help(missing)
        return 1

    source_entries = dict(zip(sources, entries))
    header_entries = entries_for_headers(source_root, headers, source_entries)
    all_entries = entries + header_entries

    write_compile_commands(args.output, all_entries)
    print(f"wrote {args.output} with {len(all_entries)} entries")
    if args.print_files:
        for path in sources + headers:
            print(path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
