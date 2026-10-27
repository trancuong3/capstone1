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
import type { ReadingManagementService } from "@/lib/api/reading-management-service";
import type { ReadingSocketAdapter } from "@/lib/api/reading-socket-adapter";
import type { SessionService } from "@/lib/api/session-service";
import type { TutorService } from "@/lib/api/tutor-service";

import { createChildService } from "@/lib/api/child-service";
import { createBookService } from "@/lib/api/book-service";
import { createSessionService } from "@/lib/api/session-service";
import { createReportService } from "@/lib/api/report-service";
import { createDifficultWordService } from "@/lib/api/difficult-word-service";
import { createProfileService } from "@/lib/api/profile-service";
import { createReadingService } from "@/lib/api/reading-service";
import { createReadingManagementService } from "@/lib/api/reading-management-service";
import { createPageMatchService } from "@/lib/api/page-match-service";
import { createDevicePermissionService } from "@/lib/api/device-permission-service";
import { createReadingSocketAdapter } from "@/lib/api/reading-socket-adapter";
import { createTutorService } from "@/lib/api/tutor-service";

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
  readingManagementService: ReadingManagementService;
  readingSocketAdapter: ReadingSocketAdapter;
  sessionService: SessionService;
  tutorService: TutorService;
}

export const AppServicesContext = createContext<AppServices | null>(null);

interface AppServicesProviderProps {
  children: ReactNode;
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

export function AppServicesProvider({
  children,
  scenario,
}: AppServicesProviderProps) {
  const isTest =
    typeof process !== "undefined" &&
    process.env.NODE_ENV === "test" &&
    scenario !== "default";
  const isReadingEnabled = !isTest;

  const services = useMemo<AppServices>(
    () => ({
      childService: createChildService(),
      profileService: createProfileService(),
      bookService: createBookService(),
      difficultWordService: createDifficultWordService(),
      reportService: createReportService(),
      sessionService: createSessionService(),

      comprehensionService: createUnavailableService<ComprehensionService>(
        "ComprehensionService",
      ),

      readingService: isReadingEnabled
        ? createReadingService()
        : createUnavailableService<ReadingService>("ReadingService"),

      readingManagementService: createReadingManagementService(),

      pageMatchService: isReadingEnabled
        ? createPageMatchService()
        : createUnavailableService<PageMatchService>("PageMatchService"),

      devicePermissionService: isReadingEnabled
        ? createDevicePermissionService()
        : createUnavailableService<DevicePermissionService>(
            "DevicePermissionService",
          ),

      readingSocketAdapter: isReadingEnabled
        ? createReadingSocketAdapter()
        : createUnavailableService<ReadingSocketAdapter>(
            "ReadingSocketAdapter",
          ),

      tutorService: isReadingEnabled
        ? createTutorService()
        : createUnavailableService<TutorService>("TutorService"),
    }),
    [isReadingEnabled],
  );

  return (
    <AppServicesContext.Provider value={services}>
      {children}
    </AppServicesContext.Provider>
  );
}
