import { createHmac, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

// Explicit deployment check only. Never imported or called by the application.
// Sends one test to the authenticated sending mailbox, never to a parent/child.
export function buildSmokeRequest(env, now = Date.now()) {
  const from = env.SMTP_FROM_EMAIL || env.SMTP_USERNAME;
  const to = env.SMTP_USERNAME;
  const secret = env.EMAIL_RELAY_SECRET;
  if (
    !from ||
    !to ||
    !secret ||
    secret.length < 32 ||
    /[\r\n]/.test(from + to) ||
    !/^[^\s<>@]+@[^\s<>@]+$/.test(to)
  ) {
    throw new Error("Email smoke test configuration is invalid");
  }
  const body = Buffer.from(
    [
      `From: ${from}`,
      `To: ${to}`,
      "Subject: ViRead - Kiem tra email sau trien khai",
      `Message-ID: <viread-deploy-${randomUUID()}@viread.local>`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from(
        "Email thử nghiệm xác nhận hệ thống ViRead gửi email qua Vercel thành công. Không cần trả lời.",
      ).toString("base64"),
      "",
    ].join("\r\n"),
  );
  const timestamp = String(Math.floor(now / 1000));
  return {
    url: "https://viread-frontend.vercel.app/api/parent-email-relay",
    body,
    headers: {
      "Content-Type": "message/rfc822",
      "X-ViRead-Timestamp": timestamp,
      "X-ViRead-Signature": createHmac("sha256", secret)
        .update(`${timestamp}.`)
        .update(body)
        .digest("hex"),
    },
  };
}

export async function runSmokeTest(env, fetcher = fetch) {
  const request = buildSmokeRequest(env);
  const response = await fetcher(request.url, {
    method: "POST",
    headers: request.headers,
    body: request.body,
    signal: AbortSignal.timeout(45000),
    redirect: "error",
  });
  if (response.status !== 200) {
    throw new Error(
      `Email relay did not accept test (HTTP ${response.status})`,
    );
  }
  const result = await response.json();
  if (result.status !== "SENT") {
    throw new Error("Email relay did not acknowledge SMTP acceptance");
  }
  return "SENT";
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href &&
  process.env.VERCEL_ENV === "production"
) {
  try {
    await runSmokeTest(process.env);
    console.log("VIREAD_EMAIL_SMOKE_RESULT: SENT (SMTP accepted)");
  } catch {
    // Never print request headers, recipients, credentials or provider errors.
    console.error("VIREAD_EMAIL_SMOKE_RESULT: FAILED");
    process.exitCode = 1;
  }
}
