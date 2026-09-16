"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";

import { AppStoreContext } from "@/components/providers/app-store-provider";
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
import { createMockBookService } from "@/lib/mock/mock-book-service";
import { createMockChildService } from "@/lib/mock/mock-child-service";
import { createMockComprehensionService } from "@/lib/mock/mock-comprehension-service";
import { createMockDevicePermissionService } from "@/lib/mock/mock-device-permission-service";
import { createMockDifficultWordService } from "@/lib/mock/mock-difficult-word-service";
import { createMockPageMatchService } from "@/lib/mock/mock-page-match-service";
import { createMockProfileService } from "@/lib/mock/mock-profile-service";
import { createMockReportService } from "@/lib/mock/mock-report-service";
import { createMockReadingService } from "@/lib/mock/mock-reading-service";
import { createMockReadingSocketAdapter } from "@/lib/mock/mock-reading-socket-adapter";
import { createMockSessionService } from "@/lib/mock/mock-session-service";
import { createMockTutorService } from "@/lib/mock/mock-tutor-service";
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
  bookScenario?: AppMockScenario;
  children: ReactNode;
  difficultWordScenario?: Group5DemoState;
  reportScenario?: Group5DemoState;
  scenario: AppMockScenario;
  sessionScenario?: Group5DemoState;
}

export function AppServicesProvider({
  bookScenario,
  children,
  difficultWordScenario = "default",
  reportScenario = "default",
  scenario,
  sessionScenario = "default",
}: AppServicesProviderProps) {
  const store = useContext(AppStoreContext);

  if (!store) {
    throw new Error(
      "AppServicesProvider must be used inside AppStoreProvider.",
    );
  }

  const services = useMemo<AppServices>(() => {
    const bookService = createMockBookService(bookScenario ?? scenario);

    return {
      bookService,
      childService: createMockChildService(store, scenario),
      comprehensionService: createMockComprehensionService(),
      devicePermissionService: createMockDevicePermissionService(),
      difficultWordService: createMockDifficultWordService(
        store,
        difficultWordScenario,
      ),
      pageMatchService: createMockPageMatchService(),
      profileService: createMockProfileService(store, scenario),
      reportService: createMockReportService(store, reportScenario),
      readingService: createMockReadingService(store, bookService),
      readingSocketAdapter: createMockReadingSocketAdapter(),
      sessionService: createMockSessionService(store, sessionScenario),
      tutorService: createMockTutorService(),
    };
  }, [
    bookScenario,
    difficultWordScenario,
    reportScenario,
    scenario,
    sessionScenario,
    store,
  ]);

  return (
    <AppServicesContext.Provider value={services}>
      {children}
    </AppServicesContext.Provider>
  );
}
