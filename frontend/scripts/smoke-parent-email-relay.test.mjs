import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import {
  buildSmokeRequest,
  runSmokeTest,
} from "./smoke-parent-email-relay.mjs";

const env = {
  SMTP_USERNAME: "sender@example.test",
  SMTP_FROM_EMAIL: "sender@example.test",
  EMAIL_RELAY_SECRET: "test-only-secret-for-local-smoke-contract",
};

test("signs exact MIME and sends only to the authenticated sending mailbox", () => {
  const request = buildSmokeRequest(env, 1234000);
  assert.equal(request.headers["X-ViRead-Timestamp"], "1234");
  assert.equal(
    request.headers["X-ViRead-Signature"],
    createHmac("sha256", env.EMAIL_RELAY_SECRET)
      .update("1234.")
      .update(request.body)
      .digest("hex"),
  );
  assert.match(request.body.toString(), /To: sender@example.test\r\n/);
  assert.equal(
    request.url,
    "https://viread-frontend.vercel.app/api/parent-email-relay",
  );
});

test("refuses missing credentials and recipient header injection", () => {
  assert.throws(() => buildSmokeRequest({}));
  assert.throws(() =>
    buildSmokeRequest({ ...env, EMAIL_RELAY_SECRET: "short" }),
  );
  assert.throws(() =>
    buildSmokeRequest({
      ...env,
      SMTP_USERNAME: "a@b.test\r\nBcc: other@b.test",
    }),
  );
});

test("accepts only explicit SMTP success and never retries a failed request", async () => {
  let calls = 0;
  const result = await runSmokeTest(env, async (_url, options) => {
    calls += 1;
    assert.equal(options.method, "POST");
    assert.equal(options.redirect, "error");
    return new Response(JSON.stringify({ status: "SENT" }));
  });
  assert.equal(result, "SENT");
  assert.equal(calls, 1);
  await assert.rejects(() =>
    runSmokeTest(env, async () => new Response("", { status: 503 })),
  );
  await assert.rejects(() =>
    runSmokeTest(
      env,
      async () => new Response(JSON.stringify({ status: "FAILED" })),
    ),
  );
});
