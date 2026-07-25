import Link from "next/link";
import {
  Flame,
  Clock3,
  Mic,
  CalendarDays,
  Sparkles,
  ArrowRight,
  MessageSquare,
} from "lucide-react";
import {
  songs,
  getLatestTake,
  getTakesForSong,
  practiceStreak,
  totalPracticeMinutes,
  practiceLogs,
  takes,
  teacherComments,
  findStagnantMeasures,
} from "@/lib/mock/data";
import { SONG_STATUS_LABELS } from "@/lib/mock/types";
import { Badge, Card, CardTitle, PageHeader, ScoreRing, Stat } from "@/components/ui";
import { PracticeBar, ScoreTrend } from "@/components/charts";
import { daysUntil, formatDate, scoreTextClass, signed } from "@/lib/format";

export default function DashboardPage() {
  const mainSong = songs[0];
  const mainTakes = getTakesForSong(mainSong.id);
  const latest = mainTakes[mainTakes.length - 1];
  const prev = mainTakes[mainTakes.length - 2];
  const menu = latest.aiReview.practiceMenu.slice(0, 2);
  const stagnant = findStagnantMeasures(mainSong.id).slice(0, 3);
  const recentComment = [...teacherComments].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  )[0];

  const trend = mainTakes.map((t) => ({
    label: formatDate(t.recordedAt),
    score: t.overallScore,
  }));

  return (
    <div>
      <PageHeader
        title="今日も、昨日の自分と比べよう。"
        description="録音するだけで、どの小節が弱いか・前回からどう良くなったかが分かります。"
        right={
          <Link
            href={`/record?song=${mainSong.id}`}
            className="flex items-center gap-2 rounded-lg bg-violet-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-violet-500"
          >
            <Mic size={16} />
            演奏を録音する
          </Link>
        }
      />

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="連続練習日数"
          value={
            <span className="flex items-center gap-1.5">
              <Flame size={20} className="text-orange-400" />
              {practiceStreak()}
            </span>
          }
          unit="日"
        />
        <Stat label="今週の練習時間" value={totalPracticeMinutes(7)} unit="分" />
        <Stat label="録音テイク" value={takes.length} unit="件" hint="全曲合計" />
        <Stat
          label="発表会まで"
          value={mainSong.goalDate ? daysUntil(mainSong.goalDate) : "―"}
          unit="日"
          hint={mainSong.goalDescription ?? undefined}
        />
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        {/* --- 今日のおすすめ練習 --- */}
        <Card className="lg:col-span-2">
          <CardTitle
            title="今日やるべき練習"
            subtitle={`AIコーチが ${formatDate(latest.recordedAt)} の分析結果から生成`}
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
            <div className="flex items-start gap-3 rounded-lg border border-violet-500/25 bg-violet-500/10 p-4">
              <Sparkles size={17} className="mt-0.5 shrink-0 text-violet-300" />
              <p className="text-sm leading-relaxed">{latest.aiReview.headline}</p>
            </div>
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
          <CardTitle title="停滞している小節" subtitle="3週間スコアが伸びていない箇所" />
          <div className="space-y-2.5 p-5">
            {stagnant.length === 0 && (
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
            <p className="pt-1 text-[11px] leading-relaxed text-[var(--muted)]">
              練習量ではなく<strong className="text-[var(--foreground)]">練習方法</strong>を変えるべきサインです。
              通し練習ではなく、この小節を切り出した分解練習に切り替えましょう。
            </p>
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
            const t = getLatestTake(song.id);
            const list = getTakesForSong(song.id);
            const p = list.length > 1 ? list[list.length - 2] : undefined;
            const delta = t && p ? Math.round((t.overallScore - p.overallScore) * 10) / 10 : null;
            return (
              <Link key={song.id} href={`/songs/${song.id}`}>
                <Card className="h-full p-4 transition-colors hover:border-violet-500/50">
                  <div className="mb-3 flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold">{song.title}</div>
                      <div className="text-[11px] text-[var(--muted)]">{song.composer}</div>
                    </div>
                    <Badge color={song.accent}>{SONG_STATUS_LABELS[song.status]}</Badge>
                  </div>
                  <div className="flex items-center gap-3">
                    <ScoreRing score={t?.overallScore ?? 0} size={64} />
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
                        ♩= {song.currentTempo} / 目標 {song.targetTempo}
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
            subtitle={`${mainTakes.length} テイク / 総合スコアは6指標の小節平均`}
            right={
              prev && (
                <span className="text-xs text-green-400">
                  {signed(Math.round((latest.overallScore - prev.overallScore) * 10) / 10)} 点
                </span>
              )
            }
          />
          <div className="p-4">
            <ScoreTrend data={trend} />
          </div>
        </Card>

        <div className="space-y-5">
          <Card>
            <CardTitle title="練習時間" subtitle="直近14日" />
            <div className="p-4">
              <PracticeBar
                data={practiceLogs.map((l) => ({
                  date: `${new Date(l.date).getMonth() + 1}/${new Date(l.date).getDate()}`,
                  minutes: l.minutes,
                }))}
              />
            </div>
          </Card>

          <Card>
            <CardTitle title="先生からのコメント" />
            <div className="p-5">
              <div className="flex gap-3">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-cyan-500/20 text-cyan-300">
                  <MessageSquare size={15} />
                </div>
                <div>
                  <div className="text-xs font-semibold">{recentComment.author}</div>
                  <p className="mt-1 text-xs leading-relaxed text-[var(--muted)]">
                    {recentComment.body}
                  </p>
                  <Link
                    href={`/share?song=${recentComment.songId}`}
                    className="mt-2 inline-flex items-center gap-1 text-[11px] text-violet-300"
                  >
                    やりとりを見る <ArrowRight size={12} />
                  </Link>
                </div>
              </div>
            </div>
          </Card>
        </div>
      </div>

      <div className="mt-6 flex items-center gap-2 text-[11px] text-[var(--muted)]">
        <Clock3 size={13} />
        これはPoV検証用のモックです。表示されている分析結果はすべてダミーデータです。
        <CalendarDays size={13} className="ml-2" />
        基準日: 2026/07/25
      </div>
    </div>
  );
}
