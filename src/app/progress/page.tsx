import { Suspense } from "react";
import { notFound } from "next/navigation";
import { songs, getSong, getTakesForSong, findStagnantMeasures } from "@/lib/mock/data";
import ProgressView from "@/components/ProgressView";
import { listSongs as listRealSongs, getSong as getRealSong, listTakesBySong } from "@/lib/server/repository";
import { toHistorySong, sortByRecordedAtDesc } from "@/lib/real-history";
import TakeEvaluationPanel from "@/components/TakeEvaluationPanel";
import { PageHeader } from "@/components/ui";
import SongSelector from "@/components/SongSelector";

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

  if (!selectedId) notFound();

  const realSong = selectedId.startsWith("song_") ? await getRealSong(selectedId) : null;
  if (realSong) {
    const takes = await listTakesBySong(selectedId);
    if (takes.length === 0) notFound();

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
        {pipelineVersions.size > 1 && (
          <p className="mt-4 rounded-lg border border-amber-500/25 bg-amber-500/10 p-3 text-xs leading-relaxed text-amber-200">
            解析方式が異なるテイクが含まれます。テイク間の差は上達を意味しません。
          </p>
        )}
        <div className="mt-5 space-y-6">
          {ordered.map((take) => (
            <section key={take.id}>
              <h2 className="mb-2 text-sm font-semibold">
                {take.label} ・ {new Date(take.recordedAt).toLocaleString("ja-JP")}
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
  if (takes.length === 0) notFound();

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
