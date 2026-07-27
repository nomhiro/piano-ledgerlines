import fs from "node:fs";

const MEASURES = 16;
const DIV = 4;

const scale = [
  { step: "A", alter: 0, oct: 4 },
  { step: "B", alter: 0, oct: 4 },
  { step: "C", alter: 0, oct: 5 },
  { step: "D", alter: 0, oct: 5 },
  { step: "E", alter: 0, oct: 5 },
  { step: "F", alter: 0, oct: 5 },
  { step: "G", alter: 1, oct: 5 },
  { step: "A", alter: 0, oct: 5 },
];

const melody = [
  [0, 2, 4], [4, 3, 2], [1, 3, 5], [4, 2, 0],
  [2, 4, 6], [7, 6, 4], [5, 3, 1], [0, 0, 0],
  [4, 5, 6], [7, 5, 3], [2, 4, 6], [5, 3, 2],
  [0, 3, 5], [7, 6, 5], [4, 2, 1], [0, 0, 0],
];

const bass = [
  ["A", 2], ["E", 2], ["D", 3], ["A", 2],
  ["F", 2], ["C", 3], ["D", 3], ["E", 2],
  ["A", 2], ["D", 3], ["G", 2], ["C", 3],
  ["F", 2], ["E", 2], ["E", 2], ["A", 2],
];

function noteXml({ step, alter, oct, staff, voice, dur, type, stem }) {
  const a = alter ? `<alter>${alter}</alter>` : "";
  return `      <note>
        <pitch><step>${step}</step>${a}<octave>${oct}</octave></pitch>
        <duration>${dur}</duration>
        <voice>${voice}</voice>
        <type>${type}</type>
        <stem>${stem}</stem>
        <staff>${staff}</staff>
      </note>
`;
}

let body = "";
for (let m = 0; m < MEASURES; m++) {
  body += `    <measure number="${m + 1}">\n`;
  if (m === 0) {
    body += `      <attributes>
        <divisions>${DIV}</divisions>
        <key><fifths>0</fifths><mode>minor</mode></key>
        <time><beats>3</beats><beat-type>4</beat-type></time>
        <staves>2</staves>
        <clef number="1"><sign>G</sign><line>2</line></clef>
        <clef number="2"><sign>F</sign><line>4</line></clef>
      </attributes>
      <direction placement="above">
        <direction-type><words font-weight="bold">Allegretto</words></direction-type>
      </direction>
      <direction placement="below">
        <direction-type><dynamics><p/></dynamics></direction-type>
        <staff>1</staff>
      </direction>
`;
  }
  if (m === 8) {
    body += `      <direction placement="below">
        <direction-type><wedge type="crescendo"/></direction-type>
        <staff>1</staff>
      </direction>
`;
  }
  if (m === 11) {
    body += `      <direction placement="below">
        <direction-type><wedge type="stop"/></direction-type>
        <staff>1</staff>
      </direction>
      <direction placement="below">
        <direction-type><dynamics><f/></dynamics></direction-type>
        <staff>1</staff>
      </direction>
`;
  }

  for (const deg of melody[m]) {
    const n = scale[deg];
    body += noteXml({ ...n, staff: 1, voice: 1, dur: DIV, type: "quarter", stem: "up" });
  }
  body += `      <backup><duration>${DIV * 3}</duration></backup>\n`;
  const [bStep, bOct] = bass[m];
  body += noteXml({ step: bStep, alter: 0, oct: bOct, staff: 2, voice: 2, dur: DIV, type: "quarter", stem: "down" });
  for (let k = 0; k < 2; k++) {
    body += noteXml({ step: bStep, alter: 0, oct: bOct + 1, staff: 2, voice: 2, dur: DIV, type: "quarter", stem: "down" });
  }
  body += `    </measure>\n`;
}

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.1 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="3.1">
  <work><work-title>練習曲 イ短調（サンプル楽譜）</work-title></work>
  <identification>
    <creator type="composer">Sample</creator>
  </identification>
  <part-list>
    <score-part id="P1"><part-name>Piano</part-name></score-part>
  </part-list>
  <part id="P1">
${body}  </part>
</score-partwise>
`;

fs.mkdirSync("public/scores", { recursive: true });
fs.writeFileSync("public/scores/etude-in-a-minor.musicxml", xml, "utf8");
console.log("written", xml.length, "bytes");
