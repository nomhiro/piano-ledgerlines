from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase

from music21 import bar, chord, meter, note, stream

from ledgerlines_worker.reference import build_reference


class BuildReferenceTests(TestCase):
    def test_uses_global_offsets_and_expands_repeats(self) -> None:
        score = stream.Score()
        for pitches in (("C4", "E4"), ("C3", "G3")):
            part = stream.Part()
            for number in range(1, 4):
                measure = stream.Measure(number=number)
                if number == 1:
                    measure.append(meter.TimeSignature("4/4"))
                    measure.leftBarline = bar.Repeat(direction="start")
                if number == 2:
                    measure.rightBarline = bar.Repeat(direction="end")
                measure.insert(0, chord.Chord(pitches, quarterLength=1))
                measure.insert(1, note.Note(pitches[0], quarterLength=1))
                part.append(measure)
            score.insert(0, part)

        with TemporaryDirectory() as directory:
            path = Path(directory) / "score.musicxml"
            score.write("musicxml", fp=path)
            reference = build_reference(path)

        self.assertTrue(reference["hasRepeats"])
        self.assertEqual(reference["measureCount"], 3)
        self.assertEqual(max(item["startBeat"] for item in reference["notes"]), 17.0)
        self.assertEqual(
            sorted({item["startBeat"] for item in reference["notes"]}),
            [0.0, 1.0, 4.0, 5.0, 8.0, 9.0, 12.0, 13.0, 16.0, 17.0],
        )
        self.assertTrue(all(0 <= item["beatInMeasure"] < 4 for item in reference["notes"]))
