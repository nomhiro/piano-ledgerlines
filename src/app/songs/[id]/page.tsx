import { notFound } from "next/navigation";
import { getSong, getTakesForSong, findStagnantMeasures, songs } from "@/lib/mock/data";
import SongDetailView from "@/components/SongDetailView";
import { getSong as getRealSong, listTakesBySong } from "@/lib/server/repository";
import Link from "next/link";
import { Badge, Card, CardTitle, PageHeader } from "@/components/ui";
import SongManagementControls from "@/components/SongManagementControls";
import ScorePreview from "@/components/ScorePreview";
import VerifiedScoreReplacement from "@/components/VerifiedScoreReplacement";

function scoreStatusLabel(status: string, scoreSource: string | null): string {
  if (scoreSource === "pdf") return "OMRドラフト";
  switch (status) {
    case "ready":
      return "解析済み";
    case "converting_score":
      return "PDF変換中";
    case "reviewing_score":
      return "変換結果の確認待ち";
    case "omr_failed":
      return "PDF変換失敗";
    default:
      return "楽譜待ち";
  }
}

export function generateStaticParams() {
  return songs.map((s) => ({ id: s.id }));
}

export default async function SongDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (id.startsWith("song_")) {
    const song = await getRealSong(id);
    if (!song) notFound();
    const takes = await listTakesBySong(id);
    return (
      <div>
        <PageHeader
          title={song.title}
          description={`${song.composer} ・ ${song.keySignature ?? "調不明"} ・ ${song.timeSignature ?? "拍子不明"}`}
          right={
            song.status === "ready" && song.scoreSource !== "pdf" ? (
              <Link
                href={`/record?song=${song.id}`}
                className="rounded-lg bg-violet-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-violet-500"
              >
                録音する
              </Link>
            ) : undefined
          }
        />
        <div className="grid gap-5 md:grid-cols-2">
          <Card>
            <CardTitle title="楽譜情報" />
            <div className="space-y-2 p-5 text-sm text-[var(--muted)]">
              <div>ステータス: <Badge color="#8b5cf6">{scoreStatusLabel(song.status, song.scoreSource)}</Badge></div>
              {song.sourceScoreFileName && <div>登録ファイル: {song.sourceScoreFileName}</div>}
              {song.status === "omr_failed" && song.omrError && (
                <div className="text-red-300">変換エラー: {song.omrError}</div>
              )}
              <div>小節数: {song.measureCount ?? "未解析"}</div>
              <div>検出テンポ: {song.detectedTempo ? `♩=${song.detectedTempo}` : "未検出"}</div>
              {song.warnings.length > 0 && (
                <div className="text-amber-300">警告: {song.warnings.map((w) => w.message).join(" / ")}</div>
              )}
            </div>
          </Card>
          <Card>
            <CardTitle title={`演奏テイク (${takes.length})`} />
            <div className="space-y-2 p-5">
              {takes.length === 0 && <p className="text-sm text-[var(--muted)]">まだ録音がありません。</p>}
              {takes.map((take) => (
                <Link key={take.id} href={`/takes/${take.id}`} className="block rounded-lg border border-[var(--border)] p-3 text-sm hover:border-violet-500/50">
                  <div className="flex justify-between gap-3">
                    <span>{take.label}</span>
                    <span className="text-[var(--muted)]">{take.status}</span>
                  </div>
                  <div className="mt-1 text-xs text-[var(--muted)]">
                    {take.overallScore !== null
                      ? `総合 ${take.overallScore}`
                      : take.evaluation?.status === "withheld"
                        ? `判定保留${take.evaluation.reason ? `: ${take.evaluation.reason}` : ""}`
                        : "スコア未算出"}
                  </div>
                </Link>
              ))}
            </div>
          </Card>
        </div>
        {song.previewScoreFileName && (
          <ScorePreview
            scoreUrl={`/api/songs/${song.id}/score/file`}
            midiUrl={song.previewMidiFileName ? `/api/songs/${song.id}/score/file?format=midi` : null}
            isDraft={song.scoreSource === "pdf"}
            targetTempo={song.targetTempo}
          />
        )}
        {song.scoreSource === "pdf" && <VerifiedScoreReplacement songId={song.id} />}
        <SongManagementControls song={song} />
      </div>
    );
  }

  const song = getSong(id);
  const takes = getTakesForSong(id);
  if (!song || takes.length === 0) notFound();

  return (
    <SongDetailView song={song} takes={takes} stagnant={findStagnantMeasures(id)} />
  );
}
