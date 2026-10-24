"""拉取 ECDICT 词库与 lemma 表，构建本地查询索引。

数据来源：https://github.com/skywind3000/ECDICT (MIT)
"""

from __future__ import annotations

import sqlite3
import sys
import urllib.request
import zipfile
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "data"

SQLITE_ZIP = "https://github.com/skywind3000/ECDICT/releases/download/1.0.28/ecdict-sqlite-28.zip"
LEMMA_TXT = "https://raw.githubusercontent.com/skywind3000/ECDICT/master/lemma.en.txt"


def _download(url: str, dest: Path) -> None:
    if dest.exists():
        print(f"[skip] {dest.name} 已存在")
        return
    print(f"[get ] {url}")
    tmp = dest.with_suffix(dest.suffix + ".part")

    def progress(count: int, block: int, total: int) -> None:
        if total > 0:
            pct = min(100, count * block * 100 // total)
            print(f"\r       {pct:3d}%  {count * block // 1048576}MB", end="", flush=True)

    urllib.request.urlretrieve(url, tmp, reporthook=progress)
    print()
    tmp.rename(dest)


def build_indexes(db_path: Path) -> None:
    # A development slot references its sealed dictionary. Never open that
    # reference or another read-only baseline with a SQLite write connection.
    db_path = Path(db_path)
    if (db_path.is_symlink() or not db_path.is_file()
            or not db_path.stat().st_mode & 0o222
            or not db_path.parent.stat().st_mode & 0o222):
        raise ValueError("Dictionary indexing requires an independent writable file and directory")
    print("[idx ] 构建词频索引…")
    con = sqlite3.connect(db_path)
    con.execute("CREATE INDEX IF NOT EXISTS idx_frq ON stardict(frq)")
    con.execute("CREATE INDEX IF NOT EXISTS idx_bnc ON stardict(bnc)")
    con.execute("CREATE INDEX IF NOT EXISTS idx_collins ON stardict(collins)")
    con.commit()
    total = con.execute("SELECT COUNT(*) FROM stardict").fetchone()[0]
    ranked = con.execute("SELECT COUNT(*) FROM stardict WHERE frq > 0").fetchone()[0]
    con.close()
    print(f"[ok  ] 词条 {total:,} 条，其中 {ranked:,} 条有 COCA 词频")


def main() -> int:
    DATA.mkdir(exist_ok=True)

    zip_path = DATA / "ecdict-sqlite.zip"
    db_path = DATA / "stardict.db"

    if not db_path.exists():
        _download(SQLITE_ZIP, zip_path)
        print("[unzip] 解压中…")
        with zipfile.ZipFile(zip_path) as zf:
            for name in zf.namelist():
                if name.endswith(".db"):
                    with zf.open(name) as src, open(db_path, "wb") as dst:
                        while chunk := src.read(1 << 20):
                            dst.write(chunk)
                    break
            else:
                print(f"[err ] 压缩包内未找到 .db 文件：{zf.namelist()}")
                return 1
        zip_path.unlink()
    else:
        print("[skip] stardict.db 已存在")

    _download(LEMMA_TXT, DATA / "lemma.en.txt")
    build_indexes(db_path)
    print(f"[done] 词库就绪：{db_path} ({db_path.stat().st_size / 1048576:.0f}MB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
