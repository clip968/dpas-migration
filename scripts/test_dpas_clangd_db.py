#!/usr/bin/env python3

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import dpas_clangd_db


class DpasClangdDbTest(unittest.TestCase):
    def test_filters_existing_kernel_translation_units_from_history(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source_root = root / "dpas-kernel"
            (source_root / "block").mkdir(parents=True)
            (source_root / "include/linux").mkdir(parents=True)
            (source_root / "tools/testing/selftests/dpas").mkdir(parents=True)
            (source_root / "block/blk-mq.c").write_text("int x;\n")
            (source_root / "include/linux/blkdev.h").write_text("#pragma once\n")
            (source_root / "tools/testing/selftests/dpas/check.py").write_text("")

            paths = [
                "block/blk-mq.c",
                "include/linux/blkdev.h",
                "tools/testing/selftests/dpas/check.py",
                "block/deleted.c",
            ]

            self.assertEqual(
                dpas_clangd_db.filter_translation_units(source_root, paths),
                ["block/blk-mq.c"],
            )

    def test_filters_existing_headers_from_history(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source_root = root / "dpas-kernel"
            (source_root / "block").mkdir(parents=True)
            (source_root / "include/linux").mkdir(parents=True)
            (source_root / "block/blk-mq.h").write_text("#pragma once\n")
            (source_root / "include/linux/blkdev.h").write_text("#pragma once\n")

            paths = [
                "block/blk-mq.h",
                "include/linux/blkdev.h",
                "block/deleted.h",
                "tools/testing/selftests/dpas/check.h",
            ]

            self.assertEqual(
                dpas_clangd_db.filter_headers(source_root, paths),
                ["block/blk-mq.h", "include/linux/blkdev.h"],
            )

    def test_builds_host_compile_command_from_cmd_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source_root = root / "dpas-kernel"
            build_root = root / "build/dpas-kernel-vm"
            (source_root / "block").mkdir(parents=True)
            (build_root / "block").mkdir(parents=True)
            (source_root / "block/blk-mq.c").write_text("int x;\n")
            cmd_file = build_root / "block/.blk-mq.o.cmd"
            cmd_file.write_text(
                "savedcmd_block/blk-mq.o := x86_64-linux-gnu-gcc "
                "-I/work/dpas-kernel/include -I./include "
                "-include /work/dpas-kernel/include/linux/kconfig.h "
                "-c -o block/blk-mq.o /work/dpas-kernel/block/blk-mq.c  \n"
                "source_block/blk-mq.o := /work/dpas-kernel/block/blk-mq.c\n"
            )

            entry = dpas_clangd_db.entry_from_cmd_file(
                cmd_file=cmd_file,
                source_root=source_root,
                build_root=build_root,
                container_source=Path("/work/dpas-kernel"),
                container_build=Path("/work/build/dpas-kernel-vm"),
            )

            self.assertEqual(entry["directory"], str(build_root.resolve()))
            self.assertEqual(entry["file"], str((source_root / "block/blk-mq.c").resolve()))
            self.assertIn(str((source_root / "include").resolve()), entry["command"])
            self.assertIn("-I./include", entry["command"])
            self.assertNotIn("/work/dpas-kernel", entry["command"])

    def test_builds_header_entry_from_source_command(self):
        source_entry = {
            "directory": "/build",
            "file": "/repo/dpas-kernel/block/blk-mq.c",
            "command": "cc -I/repo/dpas-kernel/include -c -o block/blk-mq.o /repo/dpas-kernel/block/blk-mq.c",
        }

        header_entry = dpas_clangd_db.header_entry_from_source_entry(
            source_entry,
            Path("/repo/dpas-kernel/include/linux/blkdev.h"),
        )

        self.assertEqual(header_entry["directory"], "/build")
        self.assertEqual(header_entry["file"], "/repo/dpas-kernel/include/linux/blkdev.h")
        self.assertIn("-x c-header /repo/dpas-kernel/include/linux/blkdev.h", header_entry["command"])
        self.assertNotIn("/repo/dpas-kernel/block/blk-mq.c", header_entry["command"])

    def test_prefers_matching_source_for_block_header(self):
        source_entries = {
            "block/blk-core.c": {"file": "/repo/dpas-kernel/block/blk-core.c"},
            "block/blk-mq.c": {"file": "/repo/dpas-kernel/block/blk-mq.c"},
        }

        self.assertEqual(
            dpas_clangd_db.select_header_donor("block/blk-mq.h", source_entries),
            source_entries["block/blk-mq.c"],
        )

    def test_prefers_blk_mq_for_public_block_headers(self):
        source_entries = {
            "block/blk-core.c": {"file": "/repo/dpas-kernel/block/blk-core.c"},
            "block/blk-mq.c": {"file": "/repo/dpas-kernel/block/blk-mq.c"},
        }

        self.assertEqual(
            dpas_clangd_db.select_header_donor("include/linux/blkdev.h", source_entries),
            source_entries["block/blk-mq.c"],
        )

    def test_writes_sorted_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "compile_commands.json"
            entries = [
                {"directory": "/b", "file": "/b/z.c", "command": "cc z.c"},
                {"directory": "/b", "file": "/b/a.c", "command": "cc a.c"},
            ]

            dpas_clangd_db.write_compile_commands(output, entries)

            data = json.loads(output.read_text())
            self.assertEqual([entry["file"] for entry in data], ["/b/a.c", "/b/z.c"])


if __name__ == "__main__":
    unittest.main()
