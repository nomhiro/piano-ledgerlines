import { buildTake, type TakeSpec } from "./generate";
import type {
  AiReview,
  Assignment,
  ChatMessage,
  PracticeLog,
  Song,
  Take,
  TeacherComment,
} from "./types";

export const CURRENT_USER = { name: "現在の利用者", role: "student" as const };
export const TEACHER = { name: "担当の先生", role: "teacher" as const };

export const songs: Song[] = [
  {
    id: "chopin-waltz-64-2",
    title: "ワルツ 第7番 嬰ハ短調",
    composer: "F. Chopin",
    period: "ロマン派",
    keySignature: "嬰ハ短調",
    timeSignature: "3/4",
    difficulty: 7,
    totalMeasures: 128,
    scoreUrl: "/scores/etude-in-a-minor.musicxml",
    accent: "#8b5cf6",
    status: "polishing",
    goalDate: "2026-09-13",
    goalDescription: "大人のためのピアノ発表会（暗譜・全曲通し）",
    addedAt: "2026-04-02",
    targetTempo: 138,
    currentTempo: 126,
    sharedWithTeacher: true,
  },
  {
    id: "burgmuller-arabesque",
    title: "25の練習曲 Op.100-2「アラベスク」",
    composer: "F. Burgmüller",
    period: "ロマン派",
    keySignature: "イ短調",
    timeSignature: "2/4",
    difficulty: 3,
    totalMeasures: 40,
    scoreUrl: "/scores/etude-in-a-minor.musicxml",
    accent: "#06b6d4",
    status: "practicing",
    goalDate: "2026-08-10",
    goalDescription: "指の粒を揃えてノーミスで通す",
    addedAt: "2026-06-01",
    targetTempo: 152,
    currentTempo: 132,
    sharedWithTeacher: true,
  },
  {
    id: "bach-invention-1",
    title: "インヴェンション 第1番 BWV772",
    composer: "J.S. Bach",
    period: "バロック",
    keySignature: "ハ長調",
    timeSignature: "4/4",
    difficulty: 5,
    totalMeasures: 22,
    scoreUrl: "/scores/etude-in-a-minor.musicxml",
    accent: "#f59e0b",
    status: "practicing",
    goalDate: null,
    goalDescription: "両手の独立とテーマの歌い分け",
    addedAt: "2026-05-18",
    targetTempo: 92,
    currentTempo: 84,
    sharedWithTeacher: false,
  },
  {
    id: "debussy-reverie",
    title: "夢（Rêverie）L.68",
    composer: "C. Debussy",
    period: "近代",
    keySignature: "ヘ長調",
    timeSignature: "4/4",
    difficulty: 6,
    totalMeasures: 101,
    scoreUrl: "/scores/etude-in-a-minor.musicxml",
    accent: "#ec4899",
    status: "reading",
    goalDate: null,
    goalDescription: "まずは前半48小節の譜読み",
    addedAt: "2026-07-14",
    targetTempo: 88,
    currentTempo: 62,
    sharedWithTeacher: false,
  },
];

/* ------------------------------------------------------------------ */
/* AI 講評（Azure AI Foundry の生成結果を模したモック）                  */
/* ------------------------------------------------------------------ */

const chopinLatestReview: AiReview = {
  headline: "左手が支えになってきました。次は「20小節の壁」を崩しましょう。",
  summary:
    "前回（7/18）と比べて総合スコアが +6.4 伸びました。特に伸びたのは左手のテンポ安定で、ワルツの3拍子が体に入ってきています。一方、17〜20小節の右手の跳躍は3週間ほぼ横ばいで、ここが現在の最大のボトルネックです。ここだけを切り出した練習に時間を割く価値があります。全体としては「通せるが、難所で毎回テンポが落ちる」段階から「難所を意識的にコントロールする」段階へ移るタイミングです。",
  strengths: [
    "左手のワルツ伴奏のテンポ揺れが ±9BPM → ±4BPM に縮小。拍節感が安定しました。",
    "冒頭 1〜8小節のフレージングが自然で、頂点の置き方が音楽的です。",
    "ペダルの濁りが前回の12箇所から5箇所に減少。踏み替えの反応が良くなっています。",
  ],
  improvements: [
    "17〜20小節：右手の跳躍で内声が3回抜けています。3週間スコアが横ばいで、練習方法の変更が必要です。",
    "33小節付近：16分音符が続く箇所で無意識に +9BPM 加速しています。",
    "cresc. の設計：4小節かけるべき箇所が2小節で頭打ちになり、後半が平坦です。",
  ],
  practiceMenu: [
    {
      id: "pm-1",
      title: "17〜20小節：跳躍の着地点だけを取り出す",
      measures: [17, 20],
      tempoBpm: 72,
      minutes: 10,
      method:
        "跳躍先の和音だけを「掴む→離す」で20回。次に、跳躍前の音と着地音の2音だけを繋げて弾く。目を閉じても着地できるようになったらテンポを80→95→110と上げる。",
      why: "3週間スコアが横ばい。通し練習では改善しないため、動作そのものを分解して再学習する必要があります。",
    },
    {
      id: "pm-2",
      title: "33〜40小節：裏拍メトロノームで走りを矯正",
      measures: [33, 40],
      tempoBpm: 108,
      minutes: 8,
      method:
        "メトロノームを2拍目・3拍目だけに鳴らして演奏。自分の中で1拍目を作る感覚を養う。",
      why: "16分音符の連続で恒常的に加速する癖が検出されています（+9BPM）。",
    },
    {
      id: "pm-3",
      title: "1〜16小節：cresc. の到達点を後ろにずらす",
      measures: [1, 16],
      tempoBpm: 126,
      minutes: 7,
      method:
        "cresc. 開始をあえて pp まで落として弾き、4小節目で初めて f に到達するように音量を設計。録音して波形で確認する。",
      why: "ダイナミクスの実測カーブが2小節目で頭打ちになっており、フレーズの後半が平坦に聞こえます。",
    },
  ],
  context:
    "ショパンのワルツ Op.64-2 は、右手の装飾的な旋律と左手の厳格な3拍子の対比が要です。ロマン派のルバートは「右手が揺れても左手は動かない」のが原則。テンポ揺れの評価では、あなたの左手の安定を基準にして右手の揺れを『意図的な表現』として除外して採点しています。",
};

function genericReview(
  songTitle: string,
  mastery: number,
  measures: [number, number],
): AiReview {
  const pct = Math.round(mastery * 100);
  return {
    headline: `${songTitle}：現在の到達度は約 ${pct}% です。`,
    summary: `${measures[0]}〜${measures[1]}小節の演奏を分析しました。全体の流れは掴めていますが、いくつかの小節で音の抜けとタイミングのばらつきが検出されています。まずは弱点小節を切り出した部分練習から始めましょう。`,
    strengths: [
      "テンポの大枠は保てています。拍を数える意識ができています。",
      "フレーズの切れ目で不自然な途切れがなく、音楽が前に進んでいます。",
    ],
    improvements: [
      "スコアの低い小節に、音の抜けが集中しています。",
      "強弱の幅が全体的に狭く、平坦に聞こえます。",
    ],
    practiceMenu: [
      {
        id: "gm-1",
        title: `${measures[0]}〜${measures[0] + 3}小節：片手ずつゆっくり`,
        measures: [measures[0], measures[0] + 3],
        tempoBpm: 60,
        minutes: 10,
        method: "片手ずつ、ミスが3回連続で出ないテンポまで落として弾く。",
        why: "この区間の音程正確性が最も低く、まだ運指が固まっていません。",
      },
      {
        id: "gm-2",
        title: "全体：ダイナミクスの幅を広げる",
        measures: measures,
        tempoBpm: 80,
        minutes: 8,
        method: "p の箇所を意識的にもう一段小さく。録音して差を確認する。",
        why: "実測の音量レンジが狭く、表情がつきにくい状態です。",
      },
    ],
    context:
      "分析は、録音音声をAIで採譜し、アップロードされた楽譜データと照合して算出しています。",
  };
}

/* ------------------------------------------------------------------ */
/* テイク定義                                                          */
/* ------------------------------------------------------------------ */

const takeSpecs: TakeSpec[] = [
  // --- Chopin: 4テイク（成長が見える） ---
  {
    id: "take-cw-1",
    songId: "chopin-waltz-64-2",
    label: "テイク1（通し）",
    recordedAt: "2026-06-28T21:10:00+09:00",
    mastery: 0.32,
    measureRange: [1, 32],
    tempoBpm: 108,
    targetTempo: 138,
    durationSec: 214,
    memo: "初めての通し。17小節あたりで毎回止まる。",
    seed: 1011,
    weakMeasures: [17, 18, 19, 20, 25, 26, 33],
    stubbornMeasures: [19, 20],
    metricBias: { pedal: -8, dynamics: -6 },
    aiReview: genericReview("ワルツ 第7番", 0.32, [1, 32]),
  },
  {
    id: "take-cw-2",
    songId: "chopin-waltz-64-2",
    label: "テイク2（通し）",
    recordedAt: "2026-07-08T20:44:00+09:00",
    mastery: 0.5,
    measureRange: [1, 32],
    tempoBpm: 116,
    targetTempo: 138,
    durationSec: 198,
    memo: "左手だけ先に練習した効果あり？",
    seed: 2022,
    weakMeasures: [17, 18, 19, 20, 25, 26, 33],
    stubbornMeasures: [19, 20],
    metricBias: { pedal: -5, dynamics: -5 },
    aiReview: genericReview("ワルツ 第7番", 0.5, [1, 32]),
  },
  {
    id: "take-cw-3",
    songId: "chopin-waltz-64-2",
    label: "テイク3（通し）",
    recordedAt: "2026-07-18T22:02:00+09:00",
    mastery: 0.63,
    measureRange: [1, 32],
    tempoBpm: 122,
    targetTempo: 138,
    durationSec: 188,
    memo: "ペダルを意識。まだ17〜20が怪しい。",
    seed: 3033,
    weakMeasures: [17, 18, 19, 20, 25, 26, 33],
    stubbornMeasures: [19, 20],
    metricBias: { pedal: -2, dynamics: -4 },
    aiReview: genericReview("ワルツ 第7番", 0.63, [1, 32]),
  },
  {
    id: "take-cw-4",
    songId: "chopin-waltz-64-2",
    label: "テイク4（通し・最新）",
    recordedAt: "2026-07-24T21:36:00+09:00",
    mastery: 0.74,
    measureRange: [1, 32],
    tempoBpm: 126,
    targetTempo: 138,
    durationSec: 182,
    memo: "テンポを上げてみた。左手は安定してきた感触。",
    seed: 4044,
    weakMeasures: [17, 18, 19, 20, 25, 26, 33],
    stubbornMeasures: [19, 20],
    metricBias: { pedal: 1, dynamics: -3 },
    aiReview: chopinLatestReview,
  },
  // --- Burgmüller: 3テイク ---
  {
    id: "take-ba-1",
    songId: "burgmuller-arabesque",
    label: "テイク1（通し）",
    recordedAt: "2026-07-05T19:20:00+09:00",
    mastery: 0.41,
    measureRange: [1, 24],
    tempoBpm: 112,
    targetTempo: 152,
    durationSec: 62,
    memo: "右手の16分が転ぶ。",
    seed: 5055,
    weakMeasures: [9, 10, 17, 18],
    stubbornMeasures: [17],
    metricBias: { rhythm: -7 },
    aiReview: genericReview("アラベスク", 0.41, [1, 24]),
  },
  {
    id: "take-ba-2",
    songId: "burgmuller-arabesque",
    label: "テイク2（部分練習 9-24）",
    recordedAt: "2026-07-16T20:05:00+09:00",
    mastery: 0.58,
    measureRange: [9, 24],
    tempoBpm: 124,
    targetTempo: 152,
    durationSec: 41,
    memo: "9小節からの部分練習。",
    seed: 6066,
    weakMeasures: [9, 10, 17, 18],
    stubbornMeasures: [17],
    metricBias: { rhythm: -4 },
    aiReview: genericReview("アラベスク", 0.58, [9, 24]),
  },
  {
    id: "take-ba-3",
    songId: "burgmuller-arabesque",
    label: "テイク3（通し・最新）",
    recordedAt: "2026-07-23T20:31:00+09:00",
    mastery: 0.71,
    measureRange: [1, 24],
    tempoBpm: 132,
    targetTempo: 152,
    durationSec: 55,
    memo: "だいぶ揃ってきた。",
    seed: 7077,
    weakMeasures: [9, 10, 17, 18],
    stubbornMeasures: [17],
    metricBias: { rhythm: -1 },
    aiReview: genericReview("アラベスク", 0.71, [1, 24]),
  },
  // --- Bach: 2テイク ---
  {
    id: "take-bi-1",
    songId: "bach-invention-1",
    label: "テイク1（通し）",
    recordedAt: "2026-07-11T22:15:00+09:00",
    mastery: 0.45,
    measureRange: [1, 22],
    tempoBpm: 76,
    targetTempo: 92,
    durationSec: 78,
    memo: "左手のテーマが埋もれる。",
    seed: 8088,
    weakMeasures: [7, 8, 15, 16],
    stubbornMeasures: [15],
    metricBias: { pedal: 12, dynamics: -6 },
    aiReview: genericReview("インヴェンション 第1番", 0.45, [1, 22]),
  },
  {
    id: "take-bi-2",
    songId: "bach-invention-1",
    label: "テイク2（通し・最新）",
    recordedAt: "2026-07-22T21:48:00+09:00",
    mastery: 0.6,
    measureRange: [1, 22],
    tempoBpm: 84,
    targetTempo: 92,
    durationSec: 71,
    memo: "テーマを意識して弾いた。",
    seed: 9099,
    weakMeasures: [7, 8, 15, 16],
    stubbornMeasures: [15],
    metricBias: { pedal: 14, dynamics: -4 },
    aiReview: genericReview("インヴェンション 第1番", 0.6, [1, 22]),
  },
  // --- Debussy: 1テイク（譜読み） ---
  {
    id: "take-dr-1",
    songId: "debussy-reverie",
    label: "テイク1（譜読み 1-16）",
    recordedAt: "2026-07-20T23:02:00+09:00",
    mastery: 0.28,
    measureRange: [1, 16],
    tempoBpm: 62,
    targetTempo: 88,
    durationSec: 96,
    memo: "まだ音を追うだけで精一杯。",
    seed: 10100,
    weakMeasures: [5, 6, 11, 12, 13],
    stubbornMeasures: [12],
    metricBias: { dynamics: -10, pedal: -6 },
    aiReview: genericReview("夢（Rêverie）", 0.28, [1, 16]),
  },
];

export const takes: Take[] = takeSpecs.map(buildTake);

/* ------------------------------------------------------------------ */
/* 先生とのやりとり / 課題 / 練習ログ                                    */
/* ------------------------------------------------------------------ */

export const teacherComments: TeacherComment[] = [
  {
    id: "tc-1",
    songId: "chopin-waltz-64-2",
    takeId: "take-cw-4",
    measure: 19,
    author: TEACHER.name,
    role: "teacher",
    body: "ここ、指だけで跳ぼうとしていますね。肘から先を「移動させる」意識で。動画も送っておきます。",
    createdAt: "2026-07-25T09:12:00+09:00",
  },
  {
    id: "tc-2",
    songId: "chopin-waltz-64-2",
    takeId: "take-cw-4",
    measure: null,
    author: TEACHER.name,
    role: "teacher",
    body: "左手、前回のレッスンから見違えました。この調子でテンポ132まで上げてみましょう。次回レッスンまでに一度録音を送ってください。",
    createdAt: "2026-07-25T09:15:00+09:00",
  },
  {
    id: "tc-3",
    songId: "chopin-waltz-64-2",
    takeId: "take-cw-4",
    measure: null,
    author: CURRENT_USER.name,
    role: "student",
    body: "ありがとうございます！ 17〜20小節はAIの練習メニュー通りテンポ72から分解してやってみます。",
    createdAt: "2026-07-25T12:40:00+09:00",
  },
  {
    id: "tc-4",
    songId: "chopin-waltz-64-2",
    takeId: "take-cw-3",
    measure: 33,
    author: TEACHER.name,
    role: "teacher",
    body: "走っているのが数値でも出ていますね。裏拍メトロノーム、レッスンでやった通りに。",
    createdAt: "2026-07-19T10:02:00+09:00",
  },
  {
    id: "tc-5",
    songId: "burgmuller-arabesque",
    takeId: "take-ba-3",
    measure: 17,
    author: TEACHER.name,
    role: "teacher",
    body: "17小節、スタッカートが重いです。手首を落とさないで。",
    createdAt: "2026-07-24T08:30:00+09:00",
  },
];

export const assignments: Assignment[] = [
  {
    id: "as-1",
    songId: "chopin-waltz-64-2",
    title: "17〜20小節を テンポ110 でノーミス通過",
    detail: "AI練習メニュー pm-1 に沿って分解練習。録音を提出してください。",
    dueDate: "2026-08-01",
    status: "doing",
  },
  {
    id: "as-2",
    songId: "chopin-waltz-64-2",
    title: "全曲をテンポ132で通し録音",
    detail: "止まってもいいので最後まで。テンポキープを優先。",
    dueDate: "2026-08-01",
    status: "todo",
  },
  {
    id: "as-3",
    songId: "chopin-waltz-64-2",
    title: "1〜16小節の暗譜",
    detail: "楽譜を見ずに弾けるように。",
    dueDate: "2026-07-25",
    status: "done",
  },
  {
    id: "as-4",
    songId: "burgmuller-arabesque",
    title: "17小節のスタッカートを軽く",
    detail: "手首の脱力を意識して。テンポ140で。",
    dueDate: "2026-07-31",
    status: "todo",
  },
];

export const practiceLogs: PracticeLog[] = [
  { date: "2026-07-11", minutes: 35, takes: 2 },
  { date: "2026-07-12", minutes: 20, takes: 1 },
  { date: "2026-07-13", minutes: 0, takes: 0 },
  { date: "2026-07-14", minutes: 45, takes: 2 },
  { date: "2026-07-15", minutes: 30, takes: 1 },
  { date: "2026-07-16", minutes: 55, takes: 3 },
  { date: "2026-07-17", minutes: 25, takes: 1 },
  { date: "2026-07-18", minutes: 60, takes: 3 },
  { date: "2026-07-19", minutes: 15, takes: 1 },
  { date: "2026-07-20", minutes: 40, takes: 2 },
  { date: "2026-07-21", minutes: 30, takes: 1 },
  { date: "2026-07-22", minutes: 50, takes: 2 },
  { date: "2026-07-23", minutes: 35, takes: 2 },
  { date: "2026-07-24", minutes: 65, takes: 3 },
  { date: "2026-07-25", minutes: 20, takes: 1 },
];

export const coachChatSeed: ChatMessage[] = [
  {
    id: "cm-1",
    role: "assistant",
    body: "こんばんは。7/24 のテイク4を分析しました。左手のテンポ安定が大きく改善しています。気になっている箇所はありますか？",
  },
  {
    id: "cm-2",
    role: "user",
    body: "17〜20小節がどうしても弾けません。もう3週間くらい同じところで止まっています。",
  },
  {
    id: "cm-3",
    role: "assistant",
    body: "データを見ると、その区間のスコアは 7/8: 44点 → 7/18: 46点 → 7/24: 47点 とほぼ横ばいです。他の小節が平均 +18点 伸びているので、これは「練習量が足りない」のではなく「練習方法が合っていない」サインです。\n\n通し練習の中で17〜20小節を弾くと、直前の勢いのまま突入するため毎回同じ失敗を再現してしまいます。まずは**跳躍の着地点だけ**を取り出してください。\n\n1. 20小節目の右手の和音だけを「掴む→離す」で20回\n2. 19小節最後の音 → 20小節の着地音、この2音だけを繋げる\n3. 目を閉じて着地できるようになったら テンポ72 → 95 → 110\n\n分析では、この区間で内声（Aの音）が3回抜けています。手首が外に逃げて2・3の指が浅くなっているのが原因と考えられます。",
  },
];

/* ------------------------------------------------------------------ */
/* セレクタ                                                            */
/* ------------------------------------------------------------------ */

export function getSong(songId: string): Song | undefined {
  return songs.find((s) => s.id === songId);
}

export function getTakesForSong(songId: string): Take[] {
  return takes
    .filter((t) => t.songId === songId)
    .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
}

export function getLatestTake(songId: string): Take | undefined {
  const list = getTakesForSong(songId);
  return list[list.length - 1];
}

export function getTake(takeId: string): Take | undefined {
  return takes.find((t) => t.id === takeId);
}

export function getCommentsForSong(songId: string): TeacherComment[] {
  return teacherComments
    .filter((c) => c.songId === songId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function getAssignmentsForSong(songId: string): Assignment[] {
  return assignments.filter((a) => a.songId === songId);
}

/** 前回テイクから伸びていない = 停滞している小節 */
export function findStagnantMeasures(songId: string, threshold = 3) {
  const list = getTakesForSong(songId);
  if (list.length < 2) return [];
  const first = list[0];
  const last = list[list.length - 1];
  const firstMap = new Map(first.measureScores.map((m) => [m.measure, m.score]));
  return last.measureScores
    .filter((m) => firstMap.has(m.measure))
    .map((m) => ({
      measure: m.measure,
      delta: Math.round((m.score - firstMap.get(m.measure)!) * 10) / 10,
      score: m.score,
    }))
    .filter((m) => m.delta < threshold)
    .sort((a, b) => a.score - b.score);
}

export function practiceStreak(): number {
  let streak = 0;
  for (let i = practiceLogs.length - 1; i >= 0; i--) {
    if (practiceLogs[i].minutes > 0) streak++;
    else break;
  }
  return streak;
}

export function totalPracticeMinutes(days = 7): number {
  return practiceLogs.slice(-days).reduce((acc, l) => acc + l.minutes, 0);
}
