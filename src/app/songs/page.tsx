import Link from "next/link";
import { Plus, Music4, Target } from "lucide-react";
import { songs, getLatestTake, getTakesForSong } from "@/lib/mock/data";
import { SONG_STATUS_LABELS } from "@/lib/mock/types";
import { Badge, Card, PageHeader, ScoreRing } from "@/components/ui";
import { daysUntil, formatDate } from "@/lib/format";

export default function SongsPage() {
  return (
    <div>
      <PageHeader
        title="曲ライブラリ"
        description="自分の楽譜（MusicXML / MIDI）を登録して、1曲ずつ仕上げていきます。"
        right={
          <Link
            href="/songs/new"
            className="flex items-center gap-2 rounded-lg bg-violet-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-violet-500"
          >
            <Plus size={16} />
            曲を追加
          </Link>
        }
      />

      <div className="space-y-3">
        {songs.map((song) => {
          const list = getTakesForSong(song.id);
          const latest = getLatestTake(song.id);
          const progress = Math.round((song.currentTempo / song.targetTempo) * 100);
          return (
            <Link key={song.id} href={`/songs/${song.id}`}>
              <Card className="flex flex-wrap items-center gap-5 p-5 transition-colors hover:border-violet-500/50">
                <div
                  className="flex h-14 w-14 shrink-0 items-center justify-center rounded-lg"
                  style={{
                    backgroundColor: `${song.accent}22`,
                    border: `1px solid ${song.accent}55`,
                  }}
                >
                  <Music4 size={22} style={{ color: song.accent }} />
                </div>

                <div className="min-w-[220px] flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-base font-semibold">{song.title}</h3>
                    <Badge color={song.accent}>{SONG_STATUS_LABELS[song.status]}</Badge>
                    {song.sharedWithTeacher && <Badge color="#06b6d4">先生と共有中</Badge>}
                  </div>
                  <div className="mt-1 text-xs text-[var(--muted)]">
                    {song.composer} ・ {song.period} ・ {song.keySignature} ・{" "}
                    {song.timeSignature} ・ 全{song.totalMeasures}小節 ・ 難易度{" "}
                    {song.difficulty}/10
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-4 text-[11px] text-[var(--muted)]">
                    <span>テイク {list.length} 件</span>
                    {latest && <span>最終録音 {formatDate(latest.recordedAt)}</span>}
                    {song.goalDate && (
                      <span className="flex items-center gap-1 text-amber-300">
                        <Target size={12} />
                        {song.goalDescription}（あと {daysUntil(song.goalDate)} 日）
                      </span>
                    )}
                  </div>
                </div>

                <div className="w-40">
                  <div className="mb-1 flex justify-between text-[11px] text-[var(--muted)]">
                    <span>テンポ到達度</span>
                    <span className="tabular-nums">
                      {song.currentTempo}/{song.targetTempo}
                    </span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-[var(--surface-2)]">
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${Math.min(100, progress)}%`,
                        backgroundColor: song.accent,
                      }}
                    />
                  </div>
                </div>

                <ScoreRing score={latest?.overallScore ?? 0} size={62} label="最新" />
              </Card>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
