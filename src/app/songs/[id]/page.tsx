import { notFound } from "next/navigation";
import { getSong, getTakesForSong, findStagnantMeasures, songs } from "@/lib/mock/data";
import SongDetailView from "@/components/SongDetailView";
import { getSong as getRealSong, listTakesBySong } from "@/lib/server/repository";
import type { SongDoc } from "@/lib/server/types";
import Link from "next/link";
import { Badge, Card, CardTitle, PageHeader } from "@/components/ui";
import SongManagementControls from "@/components/SongManagementControls";
import ScorePreview from "@/components/ScorePreview";
import VerifiedScoreReplacement, {
  type ScoreReplacementReason,
} from "@/components/VerifiedScoreReplacement";
import { scoreStatusColor, scoreStatusLabel } from "@/components/song-status";

export const dynamic = "force-dynamic";

/** 正確なデジタル楽譜への差し替え・登録を促すべき状態か。促さない場合は null。 */
function scoreReplacementReason(song: SongDoc): ScoreReplacementReason | null {
  // converting_score は scoreSource が既に "pdf" になっているため、下の
  // pdf_draft 判定より先に見る必要がある。変換が止まった曲に差し替え導線が
  // 無いと、削除以外に復旧手段が無い（#45）。
  if (song.status === "converting_score") return "converting";
  if (song.scoreSource === "pdf") return "pdf_draft";
  if (song.status === "awaiting_score") {
    // createSong 直後も awaiting_score なので、状態だけでは「解析が失敗した」と
    // 断定できない。楽譜を受け付けたときに sourceScoreFileName が入るため、
    // これで「一度も上げていない」と「上げたが解析できなかった」を区別する。
    return song.sourceScoreFileName ? "parse_failed" : "not_uploaded";
  }
  if (song.status === "parsing_score") return "parsing";
  return null;
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
    const replacementReason = scoreReplacementReason(song);
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
              <div>ステータス: <Badge color={scoreStatusColor(song.status, song.scoreSource)}>{scoreStatusLabel(song.status, song.scoreSource)}</Badge></div>
              {song.sourceScoreFileName && <div>登録ファイル: {song.sourceScoreFileName}</div>}
              {song.status === "omr_failed" && song.omrError && (
                <div className="text-red-300">変換エラー: {song.omrError}</div>
              )}
              {song.lastScoreError && (
                <div className="text-red-300">解析エラー: {song.lastScoreError}</div>
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
              {/* 実データの曲詳細なので実データ用ルートを直接指す。`/takes/{id}` は
                  モック用ルートで、`take_` 接頭辞を見て redirect() するだけの
                  遠回りになっていた（#39）。 */}
              {takes.map((take) => (
                <Link key={take.id} href={`/takes/real/${take.id}`} className="block rounded-lg border border-[var(--border)] p-3 text-sm hover:border-violet-500/50">
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
        {/* PDFドラフトに加えて、参照譜が無い状態（生成失敗・解析未完了）でも
            差し替え口を出す。設計 §4.6 の「失敗時は再アップロードへ誘導する」。
            これが無いと、取り残された曲は別の曲として登録し直すしかない。 */}
        {replacementReason && (
          <VerifiedScoreReplacement songId={song.id} reason={replacementReason} />
        )}
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
