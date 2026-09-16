import type { ProgressReportDTO, ReportDateWindow } from "@/types/reports";

export interface ReportService {
  get(childId: string, window?: ReportDateWindow): Promise<ProgressReportDTO>;
}
