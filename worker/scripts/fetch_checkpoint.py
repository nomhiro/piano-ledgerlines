"""ビルド時に採譜モデル（PianoTranscription）のチェックポイントを取得する。

`worker/Dockerfile` の専用 RUN レイヤーから実行される。このレイヤーは
`requirements.txt` のインストールより前に置かれるため、Python標準ライブラリ
だけで完結させる必要がある（torch・piano_transcription_inference等は未インストール）。

背景: `piano_transcription_inference` はチェックポイントが無いと wget での自動取得を
試みるが、本番イメージ（python:3.11-slim）には wget が無いため必ず失敗し、実行時に
「[Errno 2] No such file or directory: .../note_F1=....pth」という分かりにくい
FileNotFoundError になる（docs/poc/m4-report.md 8章、worker/README.md参照）。
wget/curl を apt で追加する代わりに、このスクリプト（urllib のみ）で取得する。
"""

from __future__ import annotations

import hashlib
import pathlib
import sys
import time
import urllib.error
import urllib.request
from typing import Callable

URL = (
    "https://zenodo.org/record/4034264/files/"
    "CRNN_note_F1%3D0.9677_pedal_F1%3D0.9186.pth?download=1"
)
# 配布ファイル名は `CRNN_note_F1=...` だが、ライブラリ / worker/ledgerlines_worker/
# transcribe.py が既定で探すパスは `note_F1=0.9677_pedal_F1=0.9186.pth`
# （`CRNN_` 接頭辞なし）。保存名をそのまま変えているのはtypoではなく、
# ライブラリ側の既定値に合わせるため（m4-report.md 8章のcurlコマンドと同じ処理）。
#
# 保存先は `transcribe.DEFAULT_CHECKPOINT` と同じ導出（`Path.home()` 起点）にする。
# 現在のイメージは root で動くのでどちらも `/root/...` に解決されるが、パスを
# 直書きすると実行ユーザーが変わったときに transcribe.py 側とだけずれ、
# 「ビルドは通るのに実行時にチェックポイントが見つからない」という、
# この仕組みが防ぐはずの失敗をそのまま再現してしまう。
DEST = (
    pathlib.Path.home()
    / "piano_transcription_inference_data"
    / "note_F1=0.9677_pedal_F1=0.9186.pth"
)
# Zenodoのレスポンスヘッダー(oc-checksum)から取得した、この配布ファイル自体のMD5。
# サイズ下限だけではHTMLのエラー/リダイレクトページがたまたま下限を超える余地を
# 完全には排除できないため、内容そのものを検証する。ZenodoのレコードはDOIで
# 固定され不変のため、このハッシュは安定して使える。
EXPECTED_MD5 = "22b961b77c1878239fec963362097045"
# 実ファイルは約164MiB(171966578 bytes)。HTMLのエラー/リダイレクトページは通常
# 数KB程度なので、余裕を持った下限でも十分に見分けられる。
MIN_SIZE_BYTES = 150 * 1024 * 1024

# 164MiB を1回の GET で取るので、配布側の一過性の失敗をそのままビルド失敗に
# しないよう再試行する。実際に CD が Zenodo の HTTP 504 で落ちている
# （run 32011026498、2026-08-17）。そのときは web イメージのビルドは成功して
# いたのに、この失敗で web のデプロイまで飛ばされた。
RETRY_ATTEMPTS = 4
RETRY_BACKOFF_SEC = (5, 15, 45)


def is_retryable(error: BaseException) -> bool:
    """待って再試行する意味があるか。

    5xx と 429 は配布側の一過性の問題。4xx（URL 変更・公開設定の変更など）は
    待っても変わらないので、ビルドを止めて気づかせる。
    """
    if isinstance(error, urllib.error.HTTPError):
        return error.code == 429 or 500 <= error.code < 600
    # URLError は接続リセットや DNS 失敗を含む（HTTPError の親なので後に置く）。
    if isinstance(error, (urllib.error.URLError, TimeoutError)):
        return True
    return False


def fetch_with_retry(
    url: str,
    dest: pathlib.Path,
    *,
    attempts: int = RETRY_ATTEMPTS,
    backoff: tuple[int, ...] = RETRY_BACKOFF_SEC,
    retrieve: Callable[[str, pathlib.Path], object] = urllib.request.urlretrieve,
    verify: Callable[[pathlib.Path], str | None],
    sleep: Callable[[float], object] = time.sleep,
    log: Callable[[str], object] = print,
) -> str | None:
    """取得と検証を成功するまで繰り返す。成功なら None、諦めたら理由を返す。

    検証失敗も再試行する——途中で切れたダウンロードは例外ではなくサイズ不足や
    MD5 不一致として現れるため。
    """
    for attempt in range(1, attempts + 1):
        problem: str
        try:
            retrieve(url, dest)
        except Exception as error:  # noqa: BLE001 - 再試行の判断は is_retryable が持つ
            if not is_retryable(error):
                return f"download failed: {error!r}"
            problem = f"download failed: {error!r}"
        else:
            verified = verify(dest)
            if verified is None:
                return None
            problem = f"checkpoint download failed verification: {verified}"

        if attempt == attempts:
            return problem
        wait = backoff[min(attempt - 1, len(backoff) - 1)]
        # 再試行したことをビルドログに残す。残さないと「成功した run が実は
        # 何回も取り直していた」ことに気づけない。
        log(f"attempt {attempt}/{attempts} failed ({problem}); retrying in {wait}s")
        sleep(wait)

    return "retry loop exhausted without a verdict"


def verify(path: pathlib.Path) -> str | None:
    """検証に通れば None、失敗すれば理由を返す。"""
    size = path.stat().st_size
    if size < MIN_SIZE_BYTES:
        return (
            f"size {size} bytes is below the {MIN_SIZE_BYTES} floor - "
            "likely an HTML error/redirect page, not the model file"
        )
    digest = hashlib.md5(path.read_bytes()).hexdigest()
    if digest != EXPECTED_MD5:
        return f"MD5 mismatch: expected {EXPECTED_MD5}, got {digest}"
    return None


def main() -> int:
    # 既に正しいファイルがあれば再取得しない。イメージビルドでは毎回新しい層なので
    # 通常ヒットしないが、ローカル開発でこのスクリプトを何度も実行しても
    # 164MBを取り直さずに済む。壊れたファイルが残っている場合は取り直す。
    if DEST.exists():
        problem = verify(DEST)
        if problem is None:
            print(f"checkpoint already present and verified at {DEST}")
            return 0
        print(f"existing checkpoint at {DEST} is unusable ({problem}); re-downloading")

    DEST.parent.mkdir(parents=True, exist_ok=True)
    print(f"downloading checkpoint from {URL}")
    problem = fetch_with_retry(URL, DEST, verify=verify)
    if problem is not None:
        print(problem, file=sys.stderr)
        return 1

    print(f"downloaded {DEST.stat().st_size} bytes")
    print(f"checkpoint MD5 verified at {DEST}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
