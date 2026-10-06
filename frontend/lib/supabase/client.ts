"use client";

import { createBrowserClient } from "@supabase/ssr";

import { getSupabasePublicConfig } from "@/lib/supabase/config";

export function createBrowserSupabaseClient() {
  const { url, publishableKey } = getSupabasePublicConfig();

  return createBrowserClient(url, publishableKey, {
    auth: {
      // The AuthServiceProvider subscribes before initializing so recovery
      // callbacks cannot outrun the PASSWORD_RECOVERY listener.
      skipAutoInitialize: true,
    },
  });
}
