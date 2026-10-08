"use client";

import {
  createContext,
  useMemo,
  type ReactNode,
} from "react";

import type { BookService } from "@/lib/api/book-service";
import type { ChildService } from "@/lib/api/child-service";
import type { ComprehensionService } from "@/lib/api/comprehension-service";
import type { DevicePermissionService } from "@/lib/api/device-permission-service";
import type { DifficultWordService } from "@/lib/api/difficult-word-service";
import type { PageMatchService } from "@/lib/api/page-match-service";
import type { ProfileService } from "@/lib/api/profile-service";
import type { ReportService } from "@/lib/api/report-service";
import type { ReadingService } from "@/lib/api/reading-service";
import type { ReadingSocketAdapter } from "@/lib/api/reading-socket-adapter";
import type { SessionService } from "@/lib/api/session-service";
import type { TutorService } from "@/lib/api/tutor-service";

import { createChildService } from "@/lib/api/child-service";
import { createProfileService } from "@/lib/api/profile-service";

import type { AppMockScenario } from "@/types/ui-state";
import type { Group5DemoState } from "@/types/reports";

export interface AppServices {
  bookService: BookService;
  childService: ChildService;
  comprehensionService: ComprehensionService;
  devicePermissionService: DevicePermissionService;
  difficultWordService: DifficultWordService;
  pageMatchService: PageMatchService;
  profileService: ProfileService;
  reportService: ReportService;
  readingService: ReadingService;
  readingSocketAdapter: ReadingSocketAdapter;
  sessionService: SessionService;
  tutorService: TutorService;
}

export const AppServicesContext =
  createContext<AppServices | null>(null);

interface AppServicesProviderProps {
  children: ReactNode;

  /*
   * Giữ lại các props này để tương thích
   * với các page hiện tại của project.
   *
   * Chúng không được dùng để tạo Mock.
   */
  bookScenario?: AppMockScenario;
  difficultWordScenario?: Group5DemoState;
  reportScenario?: Group5DemoState;
  scenario?: AppMockScenario;
  sessionScenario?: Group5DemoState;
}

function createUnavailableService<T>(
  serviceName: string,
): T {
  return new Proxy(
    {},
    {
      get() {
        return () => {
          throw new Error(
            `${serviceName} is not implemented yet.`,
          );
        };
      },
    },
  ) as T;
}

export function AppServicesProvider({
  children,
}: AppServicesProviderProps) {
  const services = useMemo<AppServices>(
    () => ({
      /* ==========================================
       * CHILD PROFILE - REAL SERVICE
       * ========================================== */
      childService: createChildService(),

      /* ==========================================
       * PARENT PROFILE - REAL SERVICE
       * ========================================== */
      profileService: createProfileService(),

      /* ==========================================
       * CÁC SERVICE KHÁC
       * ==========================================
       *
       * Chưa triển khai trong phạm vi Dashboard
       * hiện tại nên vẫn giữ unavailable service.
       */
      bookService:
        createUnavailableService<BookService>(
          "BookService",
        ),

      comprehensionService:
        createUnavailableService<ComprehensionService>(
          "ComprehensionService",
        ),

      devicePermissionService:
        createUnavailableService<DevicePermissionService>(
          "DevicePermissionService",
        ),

      difficultWordService:
        createUnavailableService<DifficultWordService>(
          "DifficultWordService",
        ),

      pageMatchService:
        createUnavailableService<PageMatchService>(
          "PageMatchService",
        ),

      reportService:
        createUnavailableService<ReportService>(
          "ReportService",
        ),

      readingService:
        createUnavailableService<ReadingService>(
          "ReadingService",
        ),

      readingSocketAdapter:
        createUnavailableService<ReadingSocketAdapter>(
          "ReadingSocketAdapter",
        ),

      sessionService:
        createUnavailableService<SessionService>(
          "SessionService",
        ),

      tutorService:
        createUnavailableService<TutorService>(
          "TutorService",
        ),
    }),
    [],
  );

  return (
    <AppServicesContext.Provider value={services}>
      {children}
    </AppServicesContext.Provider>
  );
}