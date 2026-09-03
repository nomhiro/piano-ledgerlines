import { Suspense } from "react";
import Link from "next/link";
import { songs, getSong, getTakesForSong, findStagnantMeasures } from "@/lib/mock/data";
import ProgressView from "@/components/ProgressView";
import { listSongs as listRealSongs, getSong as getRealSong, listTakesBySong } from "@/lib/server/repository";
import { toHistorySong, sortByRecordedAtDesc } from "@/lib/real-history";
import TakeEvaluationPanel from "@/components/TakeEvaluationPanel";
import { PageHeader } from "@/components/ui";
import SongSelector from "@/components/SongSelector";
import EmptyTakesNotice from "@/components/EmptyTakesNotice";
import { guidanceForNoSongs, guidanceForNoTakes } from "@/components/empty-takes";
import ReanalyzeSongTakesButton from "@/components/ReanalyzeSongTakesButton";

export default async function ProgressPage({
  searchParams,
}: {
  searchParams: Promise<{ song?: string }>;
}) {
  const { song: songId } = await searchParams;
  const realSongs = await listRealSongs();
  const selectableSongs = [...realSongs.map(toHistorySong), ...songs];
  const selectedId = songId && selectableSongs.some((candidate) => candidate.id === songId)
    ? songId
    : selectableSongs[0]?.id;

  // 「データがまだ無い」は 404 ではなく空状態として扱う（#34）。404 にすると
  // 曲セレクタごと画面が消えるため、録音済みの別の曲へ移動する手段まで失われる。
  if (!selectedId) {
    return (
      <div>
        <PageHeader title="テイク一覧" description="録音したテイクを新しい順に一覧表示します。" />
        <EmptyTakesNotice guidance={guidanceForNoSongs()} />
      </div>
    );
  }

  const realSong = selectedId.startsWith("song_") ? await getRealSong(selectedId) : null;
  if (realSong) {
    const takes = await listTakesBySong(selectedId);
    if (takes.length === 0) {
      return (
        <div>
          <PageHeader
            title={`テイク一覧 — ${realSong.title}`}
            description="録音したテイクを新しい順に一覧表示し、それぞれの採点結果を示します。"
          />
          <Suspense>
            <SongSelector songs={selectableSongs} current={selectedId} />
          </Suspense>
          <EmptyTakesNotice guidance={guidanceForNoTakes(realSong)} />
        </div>
      );
    }

    const ordered = sortByRecordedAtDesc(takes);
    // docs/operations/calibration-runbook.md は「異なる解析方式の結果の差を改善量として
    // 提示しない」と定める。この画面は数値の差分を計算していないが、旧方式のテイク
    // （4指標が判定保留）と新方式のテイク（4指標が数値バー）が同じ画面に縦に並ぶと
    // 「最近のテイクで急に採点された＝上達した」と読めてしまう。混在しているときだけ
    // 注記を出す（単一方式なら不要）。
    const pipelineVersions = new Set(
      ordered
        .map((take) => (take.analysis as { pipelineVersion?: unknown } | null)?.pipelineVersion)
        .filter((version): version is string => typeof version === "string"),
    );

    return (
      <div>
        <PageHeader
          title={`テイク一覧 — ${realSong.title}`}
          description="録音したテイクを新しい順に一覧表示し、それぞれの採点結果を示します。判定保留のテイクは理由を表示します。"
        />
        <Suspense>
          <SongSelector songs={selectableSongs} current={selectedId} />
        </Suspense>
        <ReanalyzeSongTakesButton
          takeIds={ordered.filter((take) => take.status === "completed").map((take) => take.id)}
        />
        {pipelineVersions.size > 1 && (
          <p className="mt-4 rounded-lg border border-amber-500/25 bg-amber-500/10 p-3 text-xs leading-relaxed text-amber-200">
            解析方式が異なるテイクが含まれます。テイク間の差は上達を意味しません。
          </p>
        )}
        <div className="mt-5 space-y-6">
          {ordered.map((take) => (
            <section key={take.id}>
              <h2 className="mb-2 flex items-center justify-between gap-3 text-sm font-semibold">
                <span>
                  {take.label} ・ {new Date(take.recordedAt).toLocaleString("ja-JP")}
                </span>
                {/* 解析に失敗したテイクをここから直接見つけても、再解析ボタンは
                    テイク詳細（/takes/real/{id}）側にしか無い（TakeEvaluationPanel
                    はフックを持たないServer Component互換のコンポーネントなので
                    ここには置けない）。この導線が無いと辿り着けなかった。 */}
                <Link
                  href={`/takes/real/${take.id}`}
                  className="shrink-0 text-xs font-normal text-violet-300 underline underline-offset-2"
                >
                  テイク詳細を見る
                </Link>
              </h2>
              <TakeEvaluationPanel take={take} />
            </section>
          ))}
        </div>
      </div>
    );
  }

  const song = getSong(selectedId) ?? songs[0];
  const takes = getTakesForSong(song.id);
  // 現在のデモ曲は4曲すべてテイクを持つのでここには来ないが、テイクの無いデモ曲を
  // 足した日に 404 が復活しないよう、実データ経路と同じ空状態に揃えておく。
  if (takes.length === 0) {
    return (
      <div>
        <PageHeader
          title={`テイク一覧 — ${song.title}`}
          description="録音したテイクを新しい順に一覧表示し、それぞれの採点結果を示します。"
        />
        <Suspense>
          <SongSelector songs={selectableSongs} current={song.id} />
        </Suspense>
        <EmptyTakesNotice guidance={guidanceForNoTakes({ id: song.id })} />
      </div>
    );
  }

  return (
    <Suspense>
      <ProgressView
        songs={selectableSongs}
        song={song}
        takes={takes}
        stagnant={findStagnantMeasures(song.id)}
      />
    </Suspense>
  );
}
