/**
 * Zero-dependency ISO/IEC 18004 QR Code Model 2 (Byte Mode, ECC Level M) encoder
 * and printable reading-card SVG generator (#3).
 */

interface QrVersionSpec {
  readonly version: number;
  readonly totalCodewords: number;
  readonly ecCodewordsPerBlock: number;
  readonly group1Blocks: number;
  readonly group1DataCodewords: number;
  readonly group2Blocks: number;
  readonly group2DataCodewords: number;
  readonly alignmentCenters: readonly number[];
}

// ISO/IEC 18004 Table 7 & Table 9 — ECC Level M specs for Versions 1..10
const QR_VERSION_M_SPECS: readonly QrVersionSpec[] = [
  {
    version: 1,
    totalCodewords: 26,
    ecCodewordsPerBlock: 10,
    group1Blocks: 1,
    group1DataCodewords: 16,
    group2Blocks: 0,
    group2DataCodewords: 0,
    alignmentCenters: [],
  },
  {
    version: 2,
    totalCodewords: 44,
    ecCodewordsPerBlock: 16,
    group1Blocks: 1,
    group1DataCodewords: 28,
    group2Blocks: 0,
    group2DataCodewords: 0,
    alignmentCenters: [6, 18],
  },
  {
    version: 3,
    totalCodewords: 70,
    ecCodewordsPerBlock: 26,
    group1Blocks: 1,
    group1DataCodewords: 44,
    group2Blocks: 0,
    group2DataCodewords: 0,
    alignmentCenters: [6, 22],
  },
  {
    version: 4,
    totalCodewords: 100,
    ecCodewordsPerBlock: 18,
    group1Blocks: 2,
    group1DataCodewords: 32,
    group2Blocks: 0,
    group2DataCodewords: 0,
    alignmentCenters: [6, 26],
  },
  {
    version: 5,
    totalCodewords: 134,
    ecCodewordsPerBlock: 24,
    group1Blocks: 2,
    group1DataCodewords: 43,
    group2Blocks: 0,
    group2DataCodewords: 0,
    alignmentCenters: [6, 30],
  },
  {
    version: 6,
    totalCodewords: 172,
    ecCodewordsPerBlock: 16,
    group1Blocks: 4,
    group1DataCodewords: 27,
    group2Blocks: 0,
    group2DataCodewords: 0,
    alignmentCenters: [6, 34],
  },
  {
    version: 7,
    totalCodewords: 196,
    ecCodewordsPerBlock: 18,
    group1Blocks: 4,
    group1DataCodewords: 31,
    group2Blocks: 0,
    group2DataCodewords: 0,
    alignmentCenters: [6, 22, 38],
  },
  {
    version: 8,
    totalCodewords: 242,
    ecCodewordsPerBlock: 22,
    group1Blocks: 2,
    group1DataCodewords: 38,
    group2Blocks: 2,
    group2DataCodewords: 39,
    alignmentCenters: [6, 24, 42],
  },
  {
    version: 9,
    totalCodewords: 292,
    ecCodewordsPerBlock: 22,
    group1Blocks: 3,
    group1DataCodewords: 36,
    group2Blocks: 2,
    group2DataCodewords: 37,
    alignmentCenters: [6, 26, 46],
  },
  {
    version: 10,
    totalCodewords: 346,
    ecCodewordsPerBlock: 26,
    group1Blocks: 4,
    group1DataCodewords: 43,
    group2Blocks: 1,
    group2DataCodewords: 44,
    alignmentCenters: [6, 28, 50],
  },
];

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) {
      x ^= 0x11d;
    }
  }
  for (let i = 255; i < 512; i++) {
    GF_EXP[i] = GF_EXP[i - 255];
  }
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function buildRsGeneratorPoly(degree: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1);
    const factor = GF_EXP[i];
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], factor);
    }
    poly = next;
  }
  return poly;
}

function computeRsRemainder(data: Uint8Array, ecDegree: number): Uint8Array {
  const gen = buildRsGeneratorPoly(ecDegree);
  const rem = new Uint8Array(ecDegree);
  for (let i = 0; i < data.length; i++) {
    const factor = data[i] ^ rem[0];
    rem.copyWithin(0, 1);
    rem[ecDegree - 1] = 0;
    for (let j = 0; j < ecDegree; j++) {
      rem[j] ^= gfMul(gen[j + 1], factor);
    }
  }
  return rem;
}

function appendBits(bits: number[], value: number, bitLength: number): void {
  for (let i = bitLength - 1; i >= 0; i--) {
    bits.push((value >>> i) & 1);
  }
}

function computeFormatBits(eclBits: number, mask: number): number {
  const data = (eclBits << 3) | mask;
  let rem = data << 10;
  for (let i = 14; i >= 10; i--) {
    if ((rem >>> i) & 1) {
      rem ^= 0x537 << (i - 10);
    }
  }
  return ((data << 10) | rem) ^ 0x5412;
}

function computeVersionBits(version: number): number {
  let rem = version << 12;
  for (let i = 17; i >= 12; i--) {
    if ((rem >>> i) & 1) {
      rem ^= 0x1f25 << (i - 12);
    }
  }
  return (version << 12) | rem;
}

function maskBit(mask: number, row: number, col: number): boolean {
  switch (mask) {
    case 0:
      return (row + col) % 2 === 0;
    case 1:
      return row % 2 === 0;
    case 2:
      return col % 3 === 0;
    default:
      return (row + col) % 3 === 0;
  }
}

function scorePenalty(modules: boolean[][]): number {
  const n = modules.length;
  let penalty = 0;
  for (let r = 0; r < n; r++) {
    let runColor = modules[r][0];
    let runLen = 1;
    for (let c = 1; c < n; c++) {
      if (modules[r][c] === runColor) {
        runLen += 1;
        if (runLen === 5) penalty += 3;
        else if (runLen > 5) penalty += 1;
      } else {
        runColor = modules[r][c];
        runLen = 1;
      }
    }
  }
  for (let c = 0; c < n; c++) {
    let runColor = modules[0][c];
    let runLen = 1;
    for (let r = 1; r < n; r++) {
      if (modules[r][c] === runColor) {
        runLen += 1;
        if (runLen === 5) penalty += 3;
        else if (runLen > 5) penalty += 1;
      } else {
        runColor = modules[r][c];
        runLen = 1;
      }
    }
  }
  return penalty;
}

export function encodeQrMatrix(text: string): boolean[][] {
  const payload = new TextEncoder().encode(text);
  const spec = QR_VERSION_M_SPECS.find((candidate) => {
    const dataBytesCapacity =
      candidate.group1Blocks * candidate.group1DataCodewords +
      candidate.group2Blocks * candidate.group2DataCodewords;
    const countBits = candidate.version <= 9 ? 8 : 16;
    const maxBytes = Math.floor((dataBytesCapacity * 8 - 4 - countBits) / 8);
    return payload.length <= maxBytes;
  });

  if (!spec) {
    throw new Error("QR payload exceeds supported Version 10 capacity.");
  }

  const totalDataCodewords =
    spec.group1Blocks * spec.group1DataCodewords +
    spec.group2Blocks * spec.group2DataCodewords;
  const countBits = spec.version <= 9 ? 8 : 16;

  const bits: number[] = [];
  appendBits(bits, 0b0100, 4); // Byte mode indicator
  appendBits(bits, payload.length, countBits);
  for (const byte of payload) {
    appendBits(bits, byte, 8);
  }

  const capacityBits = totalDataCodewords * 8;
  appendBits(bits, 0, Math.min(4, capacityBits - bits.length));
  while (bits.length % 8 !== 0) {
    bits.push(0);
  }

  const dataBytes = new Uint8Array(totalDataCodewords);
  for (let i = 0; i < bits.length / 8; i++) {
    let b = 0;
    for (let k = 0; k < 8; k++) {
      b = (b << 1) | bits[i * 8 + k];
    }
    dataBytes[i] = b;
  }
  let padToggle = true;
  for (let i = bits.length / 8; i < totalDataCodewords; i++) {
    dataBytes[i] = padToggle ? 0xec : 0x11;
    padToggle = !padToggle;
  }

  // Split into RS blocks and interleave
  const dataBlocks: Uint8Array[] = [];
  const ecBlocks: Uint8Array[] = [];
  let offset = 0;
  for (let b = 0; b < spec.group1Blocks; b++) {
    const slice = dataBytes.slice(offset, offset + spec.group1DataCodewords);
    offset += spec.group1DataCodewords;
    dataBlocks.push(slice);
    ecBlocks.push(computeRsRemainder(slice, spec.ecCodewordsPerBlock));
  }
  for (let b = 0; b < spec.group2Blocks; b++) {
    const slice = dataBytes.slice(offset, offset + spec.group2DataCodewords);
    offset += spec.group2DataCodewords;
    dataBlocks.push(slice);
    ecBlocks.push(computeRsRemainder(slice, spec.ecCodewordsPerBlock));
  }

  const interleaved: number[] = [];
  const maxBlockLen = Math.max(
    spec.group1DataCodewords,
    spec.group2DataCodewords,
  );
  for (let i = 0; i < maxBlockLen; i++) {
    for (const blk of dataBlocks) {
      if (i < blk.length) interleaved.push(blk[i]);
    }
  }
  for (let i = 0; i < spec.ecCodewordsPerBlock; i++) {
    for (const blk of ecBlocks) {
      interleaved.push(blk[i]);
    }
  }

  const finalBits: number[] = [];
  for (const byte of interleaved) {
    appendBits(finalBits, byte, 8);
  }

  const size = spec.version * 4 + 17;
  const baseModules: boolean[][] = Array.from({ length: size }, () =>
    Array<boolean>(size).fill(false),
  );
  const isFunction: boolean[][] = Array.from({ length: size }, () =>
    Array<boolean>(size).fill(false),
  );

  const setFunctionModule = (r: number, c: number, dark: boolean) => {
    if (r < 0 || r >= size || c < 0 || c >= size) return;
    baseModules[r][c] = dark;
    isFunction[r][c] = true;
  };

  const drawFinder = (topR: number, leftC: number) => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const r = topR + dr;
        const c = leftC + dc;
        const inOuter = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
        const onRing =
          inOuter && (dr === 0 || dr === 6 || dc === 0 || dc === 6);
        const inCore = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
        setFunctionModule(r, c, onRing || inCore);
      }
    }
  };

  drawFinder(0, 0);
  drawFinder(0, size - 7);
  drawFinder(size - 7, 0);

  for (let i = 8; i < size - 8; i++) {
    const dark = i % 2 === 0;
    if (!isFunction[6][i]) setFunctionModule(6, i, dark);
    if (!isFunction[i][6]) setFunctionModule(i, 6, dark);
  }

  const centers = spec.alignmentCenters;
  for (let i = 0; i < centers.length; i++) {
    for (let j = 0; j < centers.length; j++) {
      if (
        (i === 0 && j === 0) ||
        (i === 0 && j === centers.length - 1) ||
        (i === centers.length - 1 && j === 0)
      ) {
        continue;
      }
      const cr = centers[i];
      const cc = centers[j];
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const dist = Math.max(Math.abs(dr), Math.abs(dc));
          setFunctionModule(cr + dr, cc + dc, dist !== 1);
        }
      }
    }
  }

  // Reserve format info & dark module
  for (let i = 0; i <= 8; i++) {
    if (i !== 6) {
      setFunctionModule(8, i, false);
      setFunctionModule(i, 8, false);
    }
  }
  for (let i = 0; i < 8; i++) {
    setFunctionModule(8, size - 1 - i, false);
    setFunctionModule(size - 1 - i, 8, false);
  }
  setFunctionModule(size - 8, 8, true);

  if (spec.version >= 7) {
    const vBits = computeVersionBits(spec.version);
    for (let i = 0; i < 18; i++) {
      const bit = ((vBits >>> i) & 1) === 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFunctionModule(b, a, bit);
      setFunctionModule(a, b, bit);
    }
  }

  // Place data bits in upward/downward 2-column zig-zag
  let bitIdx = 0;
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      const r = upward ? size - 1 - vert : vert;
      for (let j = 0; j < 2; j++) {
        const c = right - j;
        if (!isFunction[r][c]) {
          baseModules[r][c] =
            bitIdx < finalBits.length ? finalBits[bitIdx] === 1 : false;
          bitIdx += 1;
        }
      }
    }
    upward = !upward;
  }

  const writeFormatInfo = (grid: boolean[][], mask: number) => {
    // ECC Level M indicator = 0b00
    const bits15 = computeFormatBits(0b00, mask);
    for (let i = 0; i <= 5; i++) grid[8][i] = ((bits15 >>> i) & 1) === 1;
    grid[8][7] = ((bits15 >>> 6) & 1) === 1;
    grid[8][8] = ((bits15 >>> 7) & 1) === 1;
    grid[7][8] = ((bits15 >>> 8) & 1) === 1;
    for (let i = 9; i < 15; i++) {
      grid[14 - i][8] = ((bits15 >>> i) & 1) === 1;
    }
    for (let i = 0; i < 8; i++) {
      grid[size - 1 - i][8] = ((bits15 >>> i) & 1) === 1;
    }
    for (let i = 8; i < 15; i++) {
      grid[8][size - 15 + i] = ((bits15 >>> i) & 1) === 1;
    }
    grid[size - 8][8] = true;
  };

  let bestGrid = baseModules;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let mask = 0; mask < 4; mask++) {
    const candidate = baseModules.map((row, r) =>
      row.map((val, c) =>
        !isFunction[r][c] && maskBit(mask, r, c) ? !val : val,
      ),
    );
    writeFormatInfo(candidate, mask);
    const score = scorePenalty(candidate);
    if (score < bestScore) {
      bestScore = score;
      bestGrid = candidate;
    }
  }

  return bestGrid;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function renderQrCodeSvg(
  text: string,
  options?: {
    readonly size?: number;
    readonly margin?: number;
    readonly darkColor?: string;
    readonly lightColor?: string;
    readonly title?: string;
  },
): string {
  const matrix = encodeQrMatrix(text);
  const margin = Math.max(2, options?.margin ?? 4);
  const pixelSize = Math.max(96, options?.size ?? 220);
  const darkColor = options?.darkColor ?? "#153A53";
  const lightColor = options?.lightColor ?? "#FFFFFF";
  const viewSize = matrix.length + margin * 2;

  const pathCommands: string[] = [];
  for (let r = 0; r < matrix.length; r++) {
    for (let c = 0; c < matrix[r].length; c++) {
      if (matrix[r][c]) {
        pathCommands.push(`M${c + margin} ${r + margin}h1v1h-1z`);
      }
    }
  }

  const titleNode = options?.title
    ? `<title>${escapeXml(options.title)}</title>`
    : "";

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${viewSize} ${viewSize}" width="${pixelSize}" height="${pixelSize}" shape-rendering="crispEdges" role="img">${titleNode}<rect width="100%" height="100%" fill="${escapeXml(lightColor)}"/><path d="${pathCommands.join("")}" fill="${escapeXml(darkColor)}"/></svg>`;
}
