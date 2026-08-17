"""ビルド時に Audiveris（AGPL-3.0）を取得して /opt/audiveris へ展開する。

`worker/Dockerfile` の専用 RUN レイヤーから requirements.txt のインストールより
前に実行されるため、Python標準ライブラリだけで完結させる。

取得の再試行は fetch_checkpoint.py の実装を再利用する（同じ配布元由来の一過性の
失敗でビルドを落とさないため。Issue #12 で CD が Zenodo の 504 で落ちている）。

配布形式についての注記: Audiveris の Linux 向け配布物は `.zip` ではなく Ubuntu 用の
`.deb`（Debian パッケージ）のみが公開されている
（https://github.com/Audiveris/audiveris/releases/tag/5.10.2）。この `.deb` の
data.tar は zstd 圧縮で、Python 3.11 の標準ライブラリ `tarfile`/`lzma` は zstd を
扱えない（`compression.zstd` が入るのは 3.14）。そのため展開だけは `dpkg-deb -x` を
subprocess で呼ぶ。これは pip 等でのフェッチではなく、Debian系ベースイメージに
最初から入っている dpkg 本体のサブコマンドを使うだけなので、標準ライブラリのみで
完結させる方針を破らない。`dpkg -i` ではなく `dpkg-deb -x` を使うのは、依存関係の
解決・postinst 等のスクリプト実行をせずファイルツリーだけを取り出したいため
（依存する共有ライブラリは Dockerfile 側で apt install する）。

`.deb` の中身はすでに `opt/audiveris/...` というツリーで、bin/Audiveris が
そのまま `AUDIVERIS_HOME`（既定 `/opt/audiveris`）に一致するレイアウトになっている。
"""

from __future__ import annotations

import os
import pathlib
import shutil
import subprocess
import sys

from fetch_checkpoint import fetch_with_retry

VERSION = os.environ.get("AUDIVERIS_VERSION", "5.10.2")
URL = (
    f"https://github.com/Audiveris/audiveris/releases/download/"
    f"{VERSION}/Audiveris-{VERSION}-ubuntu22.04-x86_64.deb"
)
DEST_DIR = pathlib.Path(os.environ.get("AUDIVERIS_HOME", "/opt/audiveris"))
ARCHIVE = pathlib.Path("/tmp/audiveris.deb")
EXTRACT_ROOT = pathlib.Path("/tmp/audiveris-extract")
# 実体は約68MiB。HTMLのエラー/リダイレクトページを弾くための下限。
MIN_SIZE_BYTES = 10 * 1024 * 1024
# `ar` 形式（.deb の実体）のマジックバイト。
AR_MAGIC = b"!<arch>\n"


def verify(path: pathlib.Path) -> str | None:
    size = path.stat().st_size
    if size < MIN_SIZE_BYTES:
        return (
            f"size {size} bytes is below the {MIN_SIZE_BYTES} floor - "
            "likely an HTML error/redirect page, not the Audiveris archive"
        )
    with path.open("rb") as f:
        magic = f.read(len(AR_MAGIC))
    if magic != AR_MAGIC:
        return f"downloaded file is not a .deb (ar) archive (magic={magic!r})"
    return None


def main() -> int:
    print(f"downloading Audiveris {VERSION} from {URL}")
    problem = fetch_with_retry(URL, ARCHIVE, verify=verify)
    if problem is not None:
        print(problem, file=sys.stderr)
        return 1

    EXTRACT_ROOT.mkdir(parents=True, exist_ok=True)
    result = subprocess.run(
        ["dpkg-deb", "-x", str(ARCHIVE), str(EXTRACT_ROOT)],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        print(f"dpkg-deb -x failed: {result.stderr.strip()}", file=sys.stderr)
        return 1
    ARCHIVE.unlink()

    extracted = EXTRACT_ROOT / "opt" / "audiveris"
    if not extracted.is_dir():
        print(
            f"expected {extracted} after extraction; archive layout differs. "
            f"contents of {EXTRACT_ROOT}: {sorted(str(p) for p in EXTRACT_ROOT.rglob('*'))[:50]}",
            file=sys.stderr,
        )
        return 1

    DEST_DIR.parent.mkdir(parents=True, exist_ok=True)
    if DEST_DIR.exists():
        shutil.rmtree(DEST_DIR)
    shutil.move(str(extracted), str(DEST_DIR))
    shutil.rmtree(EXTRACT_ROOT, ignore_errors=True)

    launcher = DEST_DIR / "bin" / "Audiveris"
    if not launcher.exists():
        print(
            f"launcher not found at {launcher}; archive layout differs. "
            f"contents: {sorted(p.name for p in DEST_DIR.iterdir())}",
            file=sys.stderr,
        )
        return 1
    launcher.chmod(0o755)
    print(f"Audiveris {VERSION} installed at {DEST_DIR}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
