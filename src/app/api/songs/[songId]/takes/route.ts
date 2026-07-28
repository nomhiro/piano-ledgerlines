import { NextResponse } from "next/server";
import { createTake, getSong, listTakesBySong } from "@/lib/server/repository";

export const runtime = "nodejs";

// GET /api/songs/{songId}/takes — テイク一覧 (api.md #13)
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ songId: string }> }
) {
  const { songId } = await params;
  const takes = await listTakesBySong(songId);
  return NextResponse.json({ takes });
}

// POST /api/songs/{songId}/takes — テイク作成 (api.md 5.2 #14)
// ローカル簡略版: アップロードURL発行の代わりに、この直後
// `POST /api/takes/{takeId}/audio-upload` へ直接multipartで音声を送ってもらう。
export async function POST(
  request: Request,
  { params }: { params: Promise<{ songId: string }> }
) {
  const { songId } = await params;
  const song = await getSong(songId);
  if (!song) {
    return NextResponse.json(
      { error: { code: "NOT_FOUND", message: "song not found" } },
      { status: 404 }
    );
  }

  const body = await request.json();
  const durationSec = Number(body.durationSec);
  if (!Number.isFinite(durationSec) || durationSec < 5 || durationSec > 900) {
    return NextResponse.json(
      { error: { code: "VALIDATION_FAILED", message: "durationSec must be 5-900" } },
      { status: 400 }
    );
  }

  const range = body.requestedMeasureRange;
  const measureCount = song.measureCount ?? Number.MAX_SAFE_INTEGER;
  if (
    !Array.isArray(range) ||
    range.length !== 2 ||
    range[0] > range[1] ||
    range[0] < 1 ||
    range[1] > measureCount
  ) {
    return NextResponse.json(
      {
        error: {
          code: "VALIDATION_FAILED",
          message: "requestedMeasureRange must be within the song's measure count",
        },
      },
      { status: 400 }
    );
  }

  const take = await createTake(songId, {
    label: typeof body.label === "string" ? body.label : "無題のテイク",
    recordedAt: typeof body.recordedAt === "string" ? body.recordedAt : new Date().toISOString(),
    durationSec,
    requestedMeasureRange: [range[0], range[1]],
    requestedTempo: typeof body.requestedTempo === "number" ? body.requestedTempo : null,
    inputKind: body.inputKind === "midi" ? "midi" : "audio",
    contentType: typeof body.contentType === "string" ? body.contentType : null,
  });

  return NextResponse.json({ takeId: take.id, status: take.status, take }, { status: 201 });
}
