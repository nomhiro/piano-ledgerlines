import { NextRequest, NextResponse } from "next/server";
import { createSong, listSongs } from "@/lib/server/repository";

export const runtime = "nodejs";

// GET /api/songs — 曲一覧 (api.md #4)
export async function GET() {
  const songs = await listSongs();
  return NextResponse.json({ songs });
}

// POST /api/songs — 曲作成 (api.md 5.1)
// ローカル縦串フェーズの簡略化: SAS発行の代わりに、この後 `POST /api/songs/{id}/score`
// へ直接multipartでファイルをアップロードしてもらう2ステップ構成にしている。
export async function POST(request: NextRequest) {
  const body = await request.json();
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const composer = typeof body.composer === "string" ? body.composer.trim() : "";

  if (!title || title.length > 200) {
    return NextResponse.json(
      { error: { code: "VALIDATION_FAILED", message: "title must be 1-200 chars" } },
      { status: 400 }
    );
  }

  const targetTempo =
    typeof body.targetTempo === "number" ? body.targetTempo : null;
  if (targetTempo !== null && (targetTempo < 20 || targetTempo > 300)) {
    return NextResponse.json(
      { error: { code: "VALIDATION_FAILED", message: "targetTempo must be 20-300" } },
      { status: 400 }
    );
  }

  const song = await createSong({
    title,
    composer,
    targetTempo,
    targetDate: typeof body.targetDate === "string" ? body.targetDate : null,
  });

  return NextResponse.json(
    { songId: song.id, status: song.status, song },
    { status: 201 }
  );
}
