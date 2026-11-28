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
import { fiveMinTrainEn } from "@/messages/features/five_min_train";
import { offlinePackEn } from "@/messages/features/offline_pack";
import { coReadingEn } from "../features/co_reading_messages";
import { microStoryEn } from "../features/micro_story_messages";
import { phonemeGardenEn } from "../features/phoneme_garden_messages";
import { prosodyCoachEn } from "../features/prosody_coach_messages";
import { regionalDialectEn } from "../features/regional_dialect_messages";
import { scanInstantEn } from "../features/scan_instant";
import { wordGlossaryEn } from "../features/word_glossary_messages";
import type { MessagesDictionary } from "@/lib/i18n/types";

const messages: MessagesDictionary = {
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
  scanInstant: scanInstantEn,
  wordGlossary: wordGlossaryEn,
  fiveMinTrain: fiveMinTrainEn,
  microStory: microStoryEn,
  offlinePack: offlinePackEn,
  prosodyCoach: prosodyCoachEn,
  regionalDialect: regionalDialectEn,
  coReading: coReadingEn,
  phonemeGarden: phonemeGardenEn,
};

export default messages;
