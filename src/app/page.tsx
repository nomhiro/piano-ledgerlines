import Link from "next/link";
import { Flame, Mic, Sparkles, ArrowRight } from "lucide-react";
import { listSongs, listTakesBySong } from "@/lib/server/repository";
import type { SongDoc, TakeDoc } from "@/lib/server/types";
import { Badge, Card, CardTitle, PageHeader, ScoreRing, Stat } from "@/components/ui";
import { PracticeBar, ScoreTrend } from "@/components/charts";
import { daysUntil, formatDate, scoreTextClass, signed } from "@/lib/format";
import EmptyTakesNotice from "@/components/EmptyTakesNotice";
import { guidanceForNoSongs, guidanceForNoTakes } from "@/components/empty-takes";
import {
  dailyRecordedMinutes,
  latestAndPrevious,
  recordedMinutesInLastDays,
  recordingDayStreak,
  stagnantMeasures,
} from "@/lib/dashboard";
import { toCoachTake } from "@/lib/real-history";
import { scoreStatusColor, scoreStatusLabel } from "@/components/song-status";

// ユーザーごとの実データを出すので静的化できない。
export const dynamic = "force-dynamic";

const HEADER_TITLE = "今日も、昨日の自分と比べよう。";
const HEADER_DESCRIPTION =
  "録音するだけで、どの小節が弱いか・前回からどう良くなったかが分かります。";

/**
 * 総合スコアが出せない理由。テイク自身が持つ理由を優先して出す——指標式の検証が
 * 済んで `overallScore` が入るようになれば、この関数を通らず数字が出る（#40）。
 */
function withheldReason(take: TakeDoc): string {
  return (
    take.evaluation?.reason ??
    "総合スコアは指標式の検証が済むまで出していません。小節ごとのスコアは確認できます。"
  );
}

function recordCta(songs: SongDoc[], preferredSongId?: string) {
  const target =
    songs.find((song) => song.id === preferredSongId && song.status === "ready") ??
    songs.find((song) => song.status === "ready");
  if (!target) return undefined;
  return (
    <Link
      href={`/record?song=${target.id}`}
      className="flex items-center gap-2 rounded-lg bg-violet-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-violet-500"
    >
      <Mic size={16} />
      演奏を録音する
    </Link>
  );
}

export default async function DashboardPage() {
  const songs = await listSongs();

  // 「データがまだ無い」は空状態として扱う（#34）。デモのスコアや練習ストリークを
  // 代わりに見せると、他人の記録を自分の記録として読ませることになる。
  if (songs.length === 0) {
    return (
      <div>
        <PageHeader title={HEADER_TITLE} description={HEADER_DESCRIPTION} />
        <EmptyTakesNotice guidance={guidanceForNoSongs()} />
      </div>
    );
  }

  const takesBySong = new Map<string, TakeDoc[]>(
    await Promise.all(
      songs.map(async (song) => [song.id, await listTakesBySong(song.id)] as const),
    ),
  );
  const allTakes = songs.flatMap((song) => takesBySong.get(song.id) ?? []);

  if (allTakes.length === 0) {
    const target = songs.find((song) => song.status === "ready") ?? songs[0];
    return (
      <div>
        <PageHeader
          title={HEADER_TITLE}
          description={HEADER_DESCRIPTION}
          right={recordCta(songs)}
        />
        <EmptyTakesNotice guidance={guidanceForNoTakes(target)} />
      </div>
    );
  }

  const today = new Date();
  const { latest: latestOverall } = latestAndPrevious(allTakes);
  // 主曲は最後に録音した曲。曲一覧の先頭に固定すると、今練習している曲が
  // 画面の主役にならない。
  const mainSong = songs.find((song) => song.id === latestOverall?.songId) ?? songs[0];
  const mainTakes = takesBySong.get(mainSong.id) ?? [];
  const { latest, previous } = latestAndPrevious(mainTakes);
  const stagnant = stagnantMeasures(mainTakes).slice(0, 3);
  const menu = latest ? toCoachTake(latest).aiReview.practiceMenu.slice(0, 2) : [];
  const headline = latest ? toCoachTake(latest).aiReview.headline : "";

  // 総合スコアが入っているテイクだけで推移を描く。全件 null の間はグラフを
  // 出さずに理由を出す（0 点として描くのは #29 と同型のバグ）。
  const trend = [...mainTakes]
    .sort((a, b) => new Date(a.recordedAt).getTime() - new Date(b.recordedAt).getTime())
    .flatMap((take) =>
      take.overallScore === null
        ? []
        : [{ label: formatDate(take.recordedAt), score: take.overallScore }],
    );
  const overallDelta =
    latest?.overallScore != null && previous?.overallScore != null
      ? Math.round((latest.overallScore - previous.overallScore) * 10) / 10
      : null;

  return (
    <div>
      <PageHeader
        title={HEADER_TITLE}
        description={HEADER_DESCRIPTION}
        right={recordCta(songs, mainSong.id)}
      />

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="連続録音日数"
          value={
            <span className="flex items-center gap-1.5">
              <Flame size={20} className="text-orange-400" />
              {recordingDayStreak(allTakes, today)}
            </span>
          }
          unit="日"
        />
        {/* 集計元は録音の長さ（durationSec）で、練習した時間は測っていない。 */}
        <Stat
          label="今週の録音時間"
          value={recordedMinutesInLastDays(allTakes, 7, today)}
          unit="分"
          hint="録音した長さの合計"
        />
        <Stat label="録音テイク" value={allTakes.length} unit="件" hint="全曲合計" />
        <Stat
          label="目標日まで"
          value={mainSong.targetDate ? daysUntil(mainSong.targetDate) : "―"}
          unit="日"
          hint={mainSong.targetDate ? mainSong.title : "目標日は未設定"}
        />
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        {/* --- 今日のおすすめ練習 --- */}
        <Card className="lg:col-span-2">
          <CardTitle
            title="今日やるべき練習"
            subtitle={
              latest
                ? `AIコーチが ${formatDate(latest.recordedAt)} の分析結果から生成`
                : undefined
            }
            right={
              <Link
                href={`/coach?song=${mainSong.id}`}
                className="flex items-center gap-1 text-xs text-violet-300 hover:text-violet-200"
              >
                全メニュー <ArrowRight size={13} />
              </Link>
            }
          />
          <div className="space-y-3 p-5">
            {headline && (
              <div className="flex items-start gap-3 rounded-lg border border-violet-500/25 bg-violet-500/10 p-4">
                <Sparkles size={17} className="mt-0.5 shrink-0 text-violet-300" />
                <p className="text-sm leading-relaxed">{headline}</p>
              </div>
            )}
            {menu.map((item, i) => (
              <div
                key={item.id}
                className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-4"
              >
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <span className="flex h-5 w-5 items-center justify-center rounded bg-violet-600 text-[11px] font-bold text-white">
                    {i + 1}
                  </span>
                  <span className="text-sm font-semibold">{item.title}</span>
                  <Badge color="#38bdf8">♩= {item.tempoBpm}</Badge>
                  <Badge color="#8d97ad">{item.minutes} 分</Badge>
                </div>
                <p className="text-xs leading-relaxed text-[var(--muted)]">{item.method}</p>
              </div>
            ))}
          </div>
        </Card>

        {/* --- 停滞アラート --- */}
        <Card>
          <CardTitle title="停滞している小節" subtitle="初回テイクからスコアが伸びていない箇所" />
          <div className="space-y-2.5 p-5">
            {mainTakes.length < 2 && (
              <p className="text-xs text-[var(--muted)]">
                比較できるのは2回目の録音からです。同じ曲をもう一度録音すると、伸びていない小節が出ます。
              </p>
            )}
            {mainTakes.length >= 2 && stagnant.length === 0 && (
              <p className="text-xs text-[var(--muted)]">停滞している小節はありません。</p>
            )}
            {stagnant.map((s) => (
              <div
                key={s.measure}
                className="flex items-center justify-between rounded-lg border border-red-500/25 bg-red-500/10 px-3.5 py-3"
              >
                <div>
                  <div className="text-sm font-semibold">{s.measure} 小節</div>
                  <div className="text-[11px] text-[var(--muted)]">
                    初回から {signed(s.delta)} 点
                  </div>
                </div>
                <span className={`text-lg font-semibold tabular-nums ${scoreTextClass(s.score)}`}>
                  {s.score.toFixed(0)}
                </span>
              </div>
            ))}
            {stagnant.length > 0 && (
              <p className="pt-1 text-[11px] leading-relaxed text-[var(--muted)]">
                練習量ではなく<strong className="text-[var(--foreground)]">練習方法</strong>を変えるべきサインです。
                通し練習ではなく、この小節を切り出した分解練習に切り替えましょう。
              </p>
            )}
          </div>
        </Card>
      </div>

      {/* --- 練習中の曲 --- */}
      <div className="mt-6">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold tracking-wide">練習中の曲</h2>
          <Link href="/songs" className="text-xs text-violet-300 hover:text-violet-200">
            すべて見る
          </Link>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {songs.map((song) => {
            const list = takesBySong.get(song.id) ?? [];
            const pair = latestAndPrevious(list);
            const score = pair.latest?.overallScore ?? null;
            const delta =
              pair.latest?.overallScore != null && pair.previous?.overallScore != null
                ? Math.round((pair.latest.overallScore - pair.previous.overallScore) * 10) / 10
                : null;
            return (
              <Link key={song.id} href={`/songs/${song.id}`}>
                <Card className="h-full p-4 transition-colors hover:border-violet-500/50">
                  <div className="mb-3 flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold">{song.title}</div>
                      <div className="text-[11px] text-[var(--muted)]">{song.composer}</div>
                    </div>
                    {/* 「準備中」に丸めない。変換失敗を準備中と出すと、終わらない
                        処理を待たせることになる（song-status.ts）。 */}
                    <Badge color={scoreStatusColor(song.status, song.scoreSource)}>
                      {scoreStatusLabel(song.status, song.scoreSource)}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-3">
                    {/* score が null のときにリングを 0 点で描かない（#29）。 */}
                    {score !== null ? (
                      <ScoreRing score={score} size={64} />
                    ) : (
                      <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full border border-dashed border-[var(--border)] text-center text-[10px] leading-tight text-[var(--muted)]">
                        判定
                        <br />
                        保留
                      </div>
                    )}
                    <div className="space-y-1 text-[11px] text-[var(--muted)]">
                      <div>
                        前回比{" "}
                        {delta === null ? (
                          "―"
                        ) : (
                          <span className={delta >= 0 ? "text-green-400" : "text-red-400"}>
                            {signed(delta)}
                          </span>
                        )}
                      </div>
                      <div>テイク {list.length} 件</div>
                      <div>
                        ♩= {song.detectedTempo ?? "―"} / 目標 {song.targetTempo ?? "―"}
                      </div>
                    </div>
                  </div>
                </Card>
              </Link>
            );
          })}
        </div>
      </div>

      {/* --- 下段 --- */}
      <div className="mt-6 grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardTitle
            title={`スコア推移 — ${mainSong.title}`}
            subtitle={`${mainTakes.length} テイク`}
            right={
              overallDelta !== null ? (
                <span className={overallDelta >= 0 ? "text-xs text-green-400" : "text-xs text-red-400"}>
                  {signed(overallDelta)} 点
                </span>
              ) : undefined
            }
          />
          <div className="p-4">
            {/* 総合スコアが2点以上そろってから折れ線にする。それまでは理由を出す。 */}
            {trend.length >= 2 ? (
              <ScoreTrend data={trend} />
            ) : (
              <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-4 text-xs leading-relaxed text-[var(--muted)]">
                {latest ? withheldReason(latest) : "録音するとここに推移が出ます。"}
                <Link
                  href={latest ? `/takes/real/${latest.id}` : "/progress"}
                  className="ml-1 text-violet-300 underline underline-offset-2"
                >
                  小節ごとのスコアを見る
                </Link>
              </div>
            )}
          </div>
        </Card>

        <Card>
          <CardTitle title="録音時間" subtitle="直近14日" />
          <div className="p-4">
            <PracticeBar data={dailyRecordedMinutes(allTakes, 14, today)} />
          </div>
        </Card>
      </div>
    </div>
  );
}
