export interface MilestoneCertificateInput {
  readonly brandLabel: string;
  readonly heading: string;
  readonly subtitle: string;
  readonly awardedToLabel: string;
  readonly childName: string;
  readonly gradeLabel: string;
  readonly achievementLine: string;
  readonly statsLine: string;
  readonly issuedDateLabel: string;
  readonly encouragementFooter: string;
  readonly fileNameSlug?: string;
}

function wrapCanvasText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const lines: string[] = [];
  let current = words[0]!;
  for (let i = 1; i < words.length; i += 1) {
    const candidate = `${current} ${words[i]!}`;
    if (ctx.measureText(candidate).width <= maxWidth) {
      current = candidate;
    } else {
      lines.push(current);
      current = words[i]!;
    }
  }
  lines.push(current);
  return lines;
}

export function triggerPrintA4Report(): void {
  if (typeof window !== "undefined" && typeof window.print === "function") {
    window.print();
  }
}

export async function downloadMilestoneCertificatePng(
  input: MilestoneCertificateInput,
): Promise<boolean> {
  if (typeof document === "undefined") return false;
  const width = 1600;
  const height = 1131;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext("2d");
  if (!ctx) return false;

  // Warm parchment paper background
  ctx.fillStyle = "#fdfaf3";
  ctx.fillRect(0, 0, width, height);

  // Ornamental outer teal border & inner amber frame
  ctx.strokeStyle = "#0f766e";
  ctx.lineWidth = 10;
  ctx.strokeRect(42, 42, width - 84, height - 84);

  ctx.strokeStyle = "#d97706";
  ctx.lineWidth = 3;
  ctx.strokeRect(64, 64, width - 128, height - 128);

  // Top seal pill
  ctx.fillStyle = "#ecfdf5";
  ctx.fillRect(width / 2 - 190, 108, 380, 54);
  ctx.strokeStyle = "#0f766e";
  ctx.lineWidth = 2;
  ctx.strokeRect(width / 2 - 190, 108, 380, 54);

  ctx.fillStyle = "#0f766e";
  ctx.textAlign = "center";
  ctx.font = "700 24px system-ui, -apple-system, Segoe UI, sans-serif";
  ctx.fillText(input.brandLabel, width / 2, 144);

  // Main certificate heading
  ctx.fillStyle = "#16302b";
  ctx.font = "800 54px Georgia, Times New Roman, serif";
  ctx.fillText(input.heading, width / 2, 250);

  ctx.fillStyle = "#526661";
  ctx.font = "600 26px system-ui, -apple-system, Segoe UI, sans-serif";
  ctx.fillText(input.subtitle, width / 2, 302);

  // Decorative divider
  ctx.strokeStyle = "#d97706";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(width / 2 - 220, 336);
  ctx.lineTo(width / 2 + 220, 336);
  ctx.stroke();

  // Awarded to label + Child Name
  ctx.fillStyle = "#526661";
  ctx.font = "600 26px system-ui, -apple-system, Segoe UI, sans-serif";
  ctx.fillText(input.awardedToLabel, width / 2, 405);

  ctx.fillStyle = "#0f766e";
  ctx.font = "800 68px Georgia, Times New Roman, serif";
  ctx.fillText(input.childName, width / 2, 492);

  ctx.fillStyle = "#b45309";
  ctx.font = "700 28px system-ui, -apple-system, Segoe UI, sans-serif";
  ctx.fillText(input.gradeLabel, width / 2, 542);

  // Achievement highlight box
  ctx.fillStyle = "#fffbeb";
  ctx.fillRect(190, 590, width - 380, 210);
  ctx.strokeStyle = "#fcd34d";
  ctx.lineWidth = 2;
  ctx.strokeRect(190, 590, width - 380, 210);

  ctx.fillStyle = "#16302b";
  ctx.font = "700 32px system-ui, -apple-system, Segoe UI, sans-serif";
  const achievementLines = wrapCanvasText(
    ctx,
    input.achievementLine,
    width - 460,
  ).slice(0, 2);
  achievementLines.forEach((line, idx) => {
    ctx.fillText(line, width / 2, 655 + idx * 44);
  });

  ctx.fillStyle = "#0f766e";
  ctx.font = "700 26px system-ui, -apple-system, Segoe UI, sans-serif";
  ctx.fillText(input.statsLine, width / 2, 762);

  // Encouragement quote & date footer
  ctx.fillStyle = "#334e48";
  ctx.font = "italic 25px Georgia, Times New Roman, serif";
  const footerLines = wrapCanvasText(
    ctx,
    input.encouragementFooter,
    width - 360,
  ).slice(0, 2);
  footerLines.forEach((line, idx) => {
    ctx.fillText(line, width / 2, 875 + idx * 36);
  });

  ctx.fillStyle = "#526661";
  ctx.font = "600 22px system-ui, -apple-system, Segoe UI, sans-serif";
  ctx.fillText(input.issuedDateLabel, width / 2, 1005);

  const safeSlug =
    (input.fileNameSlug ?? input.childName)
      .toLowerCase()
      .replace(/[^a-z0-9-_]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "viread";
  const downloadName = `viread-certificate-${safeSlug}.png`;

  const dataUrl = await new Promise<string | null>((resolve) => {
    if (typeof canvas.toBlob === "function") {
      canvas.toBlob((blob) => {
        if (blob && typeof URL.createObjectURL === "function") {
          resolve(URL.createObjectURL(blob));
          return;
        }
        try {
          resolve(canvas.toDataURL("image/png"));
        } catch {
          resolve(null);
        }
      }, "image/png");
      return;
    }
    try {
      resolve(canvas.toDataURL("image/png"));
    } catch {
      resolve(null);
    }
  });

  if (!dataUrl) return false;
  const anchor = document.createElement("a");
  anchor.href = dataUrl;
  anchor.download = downloadName;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  if (
    dataUrl.startsWith("blob:") &&
    typeof URL.revokeObjectURL === "function"
  ) {
    setTimeout(() => URL.revokeObjectURL(dataUrl), 1500);
  }
  return true;
}
