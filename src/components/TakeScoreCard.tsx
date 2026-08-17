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
 * 小節の選択状態は持たない。`onSelectMeasure` を渡すと `ScoreView` が小節を
 * 押せるようになり、クリックで返るのは**楽譜上の**小節番号（#36）。状態は
 * 呼び出し側が持つ——指摘事項の絞り込みと同じ選択を共有する必要があるため。
 */
export default function TakeScoreCard({
  songId,
  measureScores,
  selectedMeasure,
  onSelectMeasure,
}: {
  songId: string;
  measureScores: readonly MeasureScoreInput[];
  selectedMeasure?: number | null;
  onSelectMeasure?: (measure: number) => void;
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
        subtitle={
          onSelectMeasure
            ? "小節ごとのスコアを楽譜に重ねて表示します。斜線は判定保留の小節です。小節をクリックすると指摘事項を絞り込みます。"
            : "小節ごとのスコアを楽譜に重ねて表示します。斜線は判定保留の小節です。"
        }
      />
      <div className="p-4">
        <ScoreView
          scoreUrl={scoreUrl}
          measureScores={measureScores}
          selected={selectedMeasure}
          onSelectMeasure={onSelectMeasure}
        />
      </div>
    </Card>
  );
}
