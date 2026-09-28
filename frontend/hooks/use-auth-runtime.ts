"use client";

import { useContext } from "react";

import { AuthRuntimeContext } from "@/components/auth/auth-service-provider";

export function useAuthRuntime() {
  return useContext(AuthRuntimeContext);
}
