import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SongDoc } from "./types";
import { getBlobStore } from "./blob-storage";
import { getConfig } from "./config";
import { updateSong } from "./repository";
import { runReferenceWorker } from "./worker";

function scoreBlobName(song: SongDoc): string {
  const extension = path.extname(song.scoreFileName ?? "").toLowerCase() || ".musicxml";
  return `users/${song.userId}/songs/${song.id}/scores/score${extension}`;
}

export async function processCloudScoreLocally(song: SongDoc): Promise<SongDoc> {
  const config = getConfig();
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "ledgerlines-score-"));
  try {
    const scoreDir = path.join(workDir, "scores", song.id);
    await fs.mkdir(scoreDir, { recursive: true });
    await fs.mkdir(path.join(workDir, "songs"), { recursive: true });
    await fs.writeFile(
      path.join(workDir, "songs", `${song.id}.json`),
      JSON.stringify(song),
      "utf8",
    );
    await fs.writeFile(
      path.join(scoreDir, `score${path.extname(song.scoreFileName ?? "").toLowerCase() || ".musicxml"}`),
      await getBlobStore().download(config.scoresContainer, scoreBlobName(song)),
    );

    const result = await runReferenceWorker(song.id, workDir);
    const parsedSong = JSON.parse(
      await fs.readFile(path.join(workDir, "songs", `${song.id}.json`), "utf8"),
    ) as SongDoc;
    if (result.code !== 0 || parsedSong.status !== "ready") {
      throw new Error(parsedSong.lastScoreError ?? "score parsing failed");
    }

    await getBlobStore().upload(
      config.derivedContainer,
      `users/${song.userId}/songs/${song.id}/reference.json`,
      await fs.readFile(path.join(workDir, "derived", song.id, "reference.json")),
      "application/json",
    );
    for (const [fileName, contentType] of [
      [parsedSong.previewScoreFileName, "application/vnd.recordare.musicxml+xml"],
      [parsedSong.previewMidiFileName, "audio/midi"],
    ] as const) {
      if (!fileName) continue;
      await getBlobStore().upload(
        config.scoresContainer,
        `users/${song.userId}/songs/${song.id}/scores/${fileName}`,
        await fs.readFile(path.join(scoreDir, fileName)),
        contentType,
      );
    }
    return updateSong(song.id, {
      status: "ready",
      measureCount: parsedSong.measureCount,
      scoreMeasureCount: parsedSong.scoreMeasureCount,
      keySignature: parsedSong.keySignature,
      timeSignature: parsedSong.timeSignature,
      detectedTempo: parsedSong.detectedTempo,
      hasRepeats: parsedSong.hasRepeats,
      warnings: parsedSong.warnings,
      previewScoreFileName: parsedSong.previewScoreFileName,
      previewMidiFileName: parsedSong.previewMidiFileName,
    }, song.userId);
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}
