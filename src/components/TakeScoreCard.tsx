"use client";

import { useEffect, useState } from "react";
import { Card, CardTitle } from "@/components/ui";
import ScoreView from "@/components/ScoreView";
import { getSong } from "@/lib/api/client";
import type { MeasureScoreInput } from "@/components/score-overlay";

/**
 * 実データのテイク詳細に置く楽譜ビュー。テイクの詳細レスポンスは曲の楽譜ファイル名を
 * 含まないため、曲を1件取得して楽譜 URL を決める。楽譜が無い曲や取得に失敗した場合は
 * 何も描かない（採点結果の表示を妨げないため）。
 *
 * クリックによる小節の絞り込みは持たない（表示専用）。
 */
export default function TakeScoreCard({
  songId,
  measureScores,
}: {
  songId: string;
  measureScores: readonly MeasureScoreInput[];
}) {
  const [scoreUrl, setScoreUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const { song } = await getSong(songId);
        if (!cancelled && song.previewScoreFileName) {
          setScoreUrl(`/api/songs/${songId}/score/file`);
        }
      } catch (error) {
        // 楽譜が引けないことは採点結果の表示を止める理由にならない。
        console.error("score lookup failed", error);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [songId]);

  if (!scoreUrl || measureScores.length === 0) return null;

  return (
    <Card className="mt-5">
      <CardTitle
        title="楽譜ビュー"
        subtitle="小節ごとのスコアを楽譜に重ねて表示します。斜線は判定保留の小節です。"
      />
      <div className="p-4">
        <ScoreView scoreUrl={scoreUrl} measureScores={measureScores} />
      </div>
    </Card>
  );
}
