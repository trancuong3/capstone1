import accessibility from "./accessibility.json";
import auth from "./auth.json";
import books from "./books.json";
import child from "./child.json";
import common from "./common.json";
import difficultWords from "./difficultWords.json";
import entertainment from "./entertainment.json";
import errors from "./errors.json";
import games from "./games.json";
import navigation from "./navigation.json";
import notifications from "./notifications.json";
import ocr from "./ocr.json";
import parent from "./parent.json";
import reading from "./reading.json";
import reports from "./reports.json";
import settings from "./settings.json";
import speech from "./speech.json";
import validation from "./validation.json";
import { scanInstantVi } from "../features/scan_instant";
import type { MessagesDictionary } from "@/lib/i18n/types";

export const viMessages: MessagesDictionary = {
  common,
  auth,
  navigation,
  parent,
  child,
  books,
  ocr,
  reading,
  speech,
  difficultWords,
  reports,
  entertainment,
  games,
  settings,
  errors,
  validation,
  notifications,
  accessibility,
  scanInstant: scanInstantVi,
};

export default viMessages;
