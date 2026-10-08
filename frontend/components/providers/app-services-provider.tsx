"use client";

import { createContext, useMemo, type ReactNode } from "react";

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
import { createBookService } from "@/lib/api/book-service";
import { createSessionService } from "@/lib/api/session-service";
import { createReportService } from "@/lib/api/report-service";
import { createDifficultWordService } from "@/lib/api/difficult-word-service";
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

export const AppServicesContext = createContext<AppServices | null>(null);

interface AppServicesProviderProps {
  children: ReactNode;

  /*
   * Giữ lại các props này để tương thích
   * với các page hiện tại của project.
   *
   * @deprecated Props demo chỉ giữ để tương thích consumer cũ/Reading.
   * Các service đọc thật luôn được tạo bên dưới, không đọc các props này.
   */
  bookScenario?: AppMockScenario;
  difficultWordScenario?: Group5DemoState;
  reportScenario?: Group5DemoState;
  scenario?: AppMockScenario;
  sessionScenario?: Group5DemoState;
}

function createUnavailableService<T>(serviceName: string): T {
  return new Proxy(
    {},
    {
      get() {
        return () => {
          throw new Error(`${serviceName} is not implemented yet.`);
        };
      },
    },
  ) as T;
}

export function AppServicesProvider({ children }: AppServicesProviderProps) {
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

      // Books, Sessions, Reports và Difficult Words đọc FastAPI.
      // Các service Reading/AI bên dưới chưa thuộc phạm vi chuyển dữ liệu;
      // unavailable là lỗi rõ ràng, không phải implementation mock.
      bookService: createBookService(),

      comprehensionService: createUnavailableService<ComprehensionService>(
        "ComprehensionService",
      ),

      devicePermissionService:
        createUnavailableService<DevicePermissionService>(
          "DevicePermissionService",
        ),

      difficultWordService: createDifficultWordService(),

      pageMatchService:
        createUnavailableService<PageMatchService>("PageMatchService"),

      reportService: createReportService(),

      readingService:
        createUnavailableService<ReadingService>("ReadingService"),

      readingSocketAdapter: createUnavailableService<ReadingSocketAdapter>(
        "ReadingSocketAdapter",
      ),

      sessionService: createSessionService(),

      tutorService: createUnavailableService<TutorService>("TutorService"),
    }),
    [],
  );

  return (
    <AppServicesContext.Provider value={services}>
      {children}
    </AppServicesContext.Provider>
  );
}
