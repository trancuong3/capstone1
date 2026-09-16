import { AuthServiceError, type AuthService } from "@/lib/api/auth-service";
import type { AuthMockScenario } from "@/types/auth";

const MOCK_DELAY_MS = 450;

function waitForMock(): Promise<void> {
  if (process.env.NODE_ENV === "test") {
    return Promise.resolve();
  }

  return new Promise((resolve) => window.setTimeout(resolve, MOCK_DELAY_MS));
}

export function createMockAuthService(scenario: AuthMockScenario): AuthService {
  return {
    async registerParent(): Promise<void> {
      await waitForMock();

      if (scenario === "email-used") {
        throw new AuthServiceError(
          "email-already-used",
          "The mock email address is already registered.",
        );
      }

      if (scenario === "validation-error") {
        throw new AuthServiceError(
          "registration-validation",
          "The mock registration payload did not pass provider validation.",
        );
      }

      if (scenario === "safe-error") {
        throw new AuthServiceError(
          "unexpected",
          "The mock registration provider is unavailable.",
        );
      }
    },

    async signIn(): Promise<void> {
      await waitForMock();

      if (scenario === "invalid-credentials") {
        throw new AuthServiceError(
          "invalid-credentials",
          "The mock credentials were rejected.",
        );
      }

      if (scenario === "safe-error") {
        throw new AuthServiceError(
          "unexpected",
          "The mock auth provider is unavailable.",
        );
      }
    },

    async requestPasswordReset(): Promise<void> {
      await waitForMock();

      if (scenario === "safe-error") {
        throw new AuthServiceError(
          "unexpected",
          "The mock recovery provider is unavailable.",
        );
      }
    },

    async resetPassword(): Promise<void> {
      await waitForMock();

      if (scenario === "invalid-token") {
        throw new AuthServiceError(
          "invalid-recovery-context",
          "The mock recovery context is invalid.",
        );
      }

      if (scenario === "expired-token") {
        throw new AuthServiceError(
          "expired-recovery-context",
          "The mock recovery context has expired.",
        );
      }

      if (scenario === "safe-error") {
        throw new AuthServiceError(
          "unexpected",
          "The mock reset provider is unavailable.",
        );
      }
    },
  };
}
