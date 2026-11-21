import assert from "node:assert/strict";
import test from "node:test";

import {
  checkPublishableKey,
  publicHttpsOrigin,
  verifyHostingEnvironment,
} from "./verify-hosting-env.mjs";

const allowed = {
  NEXT_PUBLIC_SUPABASE_URL: "https://sampleid.supabase.co",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:
    "sb_publishable_abcdefghijklmnopqrstuvwxyz123456789",
  NEXT_PUBLIC_API_URL: "https://capstone1-ssd8.onrender.com",
};

function legacyJwt(role) {
  const encode = (value) =>
    Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  return [
    encode({ alg: "HS256", typ: "JWT" }),
    encode({ role }),
    "signature",
  ].join(".");
}

test("accepts HTTPS origins and a safe publishable key", () => {
  assert.deepEqual(verifyHostingEnvironment(allowed), {
    supabaseUrl: allowed.NEXT_PUBLIC_SUPABASE_URL,
    apiUrl: allowed.NEXT_PUBLIC_API_URL,
  });
  assert.equal(
    publicHttpsOrigin("NEXT_PUBLIC_API_URL", allowed.NEXT_PUBLIC_API_URL + "/"),
    allowed.NEXT_PUBLIC_API_URL,
  );
});

test("supports legacy anon JWT without permitting service_role JWT", () => {
  assert.doesNotThrow(() => checkPublishableKey(legacyJwt("anon")));
  assert.throws(
    () => checkPublishableKey(legacyJwt("service_role")),
    /anon key/,
  );
  assert.throws(
    () => checkPublishableKey("sb_secret_NeverExposeThisToBrowsers123"),
    /anon key/,
  );
});

test("rejects missing settings without revealing key values", () => {
  for (const name of Object.keys(allowed)) {
    const invalid = { ...allowed, [name]: "" };
    assert.throws(() => verifyHostingEnvironment(invalid), new RegExp(name));
  }

  const sentinel = "private-token-NO-LOGGING-123";
  assert.throws(
    () =>
      verifyHostingEnvironment({
        ...allowed,
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: sentinel,
      }),
    (error) => !error.message.includes(sentinel),
  );
});

test("rejects unsafe or placeholder origin URLs", () => {
  for (const url of [
    "http://capstone1-ssd8.onrender.com",
    "http://127.0.0.1:8000",
    "https://localhost",
    "https://192.168.1.4",
    "https://test.invalid",
    "https://example.com",
    "https://example.supabase.co",
    "https://api.example.com",
    "https://api.internal",
    "https://api.example.com/books",
    "https://api.example.com?token=secret",
    "***api.example.com",
    "https://api.example.com:8443",
  ]) {
    assert.throws(
      () => publicHttpsOrigin("NEXT_PUBLIC_API_URL", url),
      /public HTTPS origin|expected an HTTPS origin/,
      url,
    );
  }
});

test("rejects Supabase and frontend URLs as API hosts", () => {
  for (const candidate of [
    allowed.NEXT_PUBLIC_SUPABASE_URL,
    "https://trancuong3.github.io",
    "https://viread.vercel.app",
  ]) {
    assert.throws(
      () =>
        verifyHostingEnvironment({
          ...allowed,
          NEXT_PUBLIC_API_URL: candidate,
        }),
      /actual HTTPS FastAPI service/,
    );
  }
});

test("rejects public secrets and production auth fixtures", () => {
  assert.throws(
    () =>
      verifyHostingEnvironment({
        ...allowed,
        NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY: "must-not-leak",
      }),
    /forbidden browser-public secret/,
  );
  assert.throws(
    () =>
      verifyHostingEnvironment({
        ...allowed,
        PLAYWRIGHT_AUTH_FIXTURES: "true",
      }),
    /PLAYWRIGHT_AUTH_FIXTURES/,
  );
});

test("rejects a preview build with unconfigured environment", () => {
  assert.throws(
    () => verifyHostingEnvironment({ VERCEL_ENV: "preview" }),
    /NEXT_PUBLIC_SUPABASE_URL/,
  );
});
