import { NextResponse } from "next/server";
import { getSong, listTakesBySong } from "@/lib/server/repository";

export const runtime = "nodejs";

// GET /api/songs/{songId} — 曲詳細 (api.md #6)
export async function GET(
  _request: Request,
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
  const takes = await listTakesBySong(songId);
  return NextResponse.json({ song, takes });
}
