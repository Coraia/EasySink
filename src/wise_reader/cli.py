"""命令行：查词、标注。供 M0/M1 无界面验收。"""

from __future__ import annotations

import argparse
import sys

from wise_reader.engine import Engine
from wise_reader.l0 import candidates
from wise_reader.l2 import filter_candidates
from wise_reader.lexicon import Lexicon
from wise_reader.profile import ReaderProfile
from wise_reader.render import render_inline
from wise_reader.store import Store
from wise_reader.tokenize import parse


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="wise-reader")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_lookup = sub.add_parser("lookup", help="查词")
    p_lookup.add_argument("word")

    p_ann = sub.add_parser("annotate", help="标注一段文本")
    p_ann.add_argument("file", nargs="?", help="文本文件；缺省读 stdin")
    p_ann.add_argument("--vocab", type=int, default=8000)
    p_ann.add_argument("--density", type=float, default=4.0)

    args = parser.parse_args(argv)
    lexicon = Lexicon()
    try:
        if args.cmd == "lookup":
            e = lexicon.lookup(args.word)
            print(f"lemma\t{lexicon.lemma(args.word)}")
            if e:
                print(f"rank\t{e.rank}")
                print(f"gloss\t{e.gloss()}")
                print(f"phon\t{e.phonetic}")
            else:
                print("未收录")
            return 0
        text = Path_read(args.file)
        doc = parse(text)
        profile = ReaderProfile(vocab_size=args.vocab, density=args.density)
        shown = filter_candidates(candidates(doc, lexicon), [], profile, len(doc.tokens))
        print(render_inline(doc, shown))
        print(
            f"\n--- {len(doc.tokens)} words, {len(shown)} notes, "
            f"{100 * len(shown) / max(len(doc.tokens), 1):.1f}% ---",
            file=sys.stderr,
        )
        return 0
    finally:
        lexicon.close()


def Path_read(path: str | None) -> str:
    if path:
        from pathlib import Path

        return Path(path).read_text(encoding="utf-8")
    return sys.stdin.read()


if __name__ == "__main__":
    raise SystemExit(main())
