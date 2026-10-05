import { AuthServiceError, type AuthService } from "@/lib/api/auth-service";
import type {
  AuthMockScenario,
  AuthSessionSnapshot,
  AuthStateChangeListener,
  AuthStateEvent,
} from "@/types/auth";

const MOCK_DELAY_MS = 450;

function createMockAuthSession(
  email = "minhanh@example.com",
  displayName = "Nguyen Minh Anh",
): AuthSessionSnapshot {
  return {
    expires_at: null,
    user: {
      display_name: displayName,
      email,
      id: "10000000-0000-4000-8000-000000000001",
    },
  };
}

function waitForMock(): Promise<void> {
  if (process.env.NODE_ENV === "test") {
    return Promise.resolve();
  }

  return new Promise((resolve) => window.setTimeout(resolve, MOCK_DELAY_MS));
}

export function createMockAuthService(scenario: AuthMockScenario): AuthService {
  let currentSession: AuthSessionSnapshot | null = null;
  const listeners = new Set<AuthStateChangeListener>();

  const updateSession = (
    event: AuthStateEvent,
    session: AuthSessionSnapshot | null,
  ) => {
    currentSession = session;
    listeners.forEach((listener) => listener(event, currentSession));
  };

  return {
    async initialize() {
      return Promise.resolve();
    },

    async registerParent(input) {
      await waitForMock();

      if (scenario === "email-used") {
        return {
          status: "email-confirmation-required",
          session: null,
        };
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

      const session = createMockAuthSession(input.email, input.displayName);
      updateSession("SIGNED_IN", session);
      return {
        status: "authenticated",
        session,
      };
    },

    async signIn(request) {
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

      const session = createMockAuthSession(request.email);
      updateSession("SIGNED_IN", session);
      return session;
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

      updateSession("SIGNED_OUT", null);
    },

    async getSession() {
      return currentSession;
    },

    async getCurrentUser() {
      return currentSession?.user ?? null;
    },

    async getCurrentRole() {
      return currentSession ? "parent" : null;
    },

    async signOut() {
      currentSession = null;
      await waitForMock();
      updateSession("SIGNED_OUT", null);
    },

    onAuthStateChange(listener) {
      listeners.add(listener);
      listener("INITIAL_SESSION", currentSession);

      return () => {
        listeners.delete(listener);
      };
    },
  };
}
