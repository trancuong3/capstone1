"use client";

import { useContext } from "react";

import { AuthServiceContext } from "@/components/auth/auth-service-provider";

export function useAuthService() {
  const service = useContext(AuthServiceContext);

  if (!service) {
    throw new Error("useAuthService must be used inside AuthServiceProvider.");
  }

  return service;
}
