import type { WordTiming } from "@/lib/api/voice-studio-service";
import type { VoiceRegion } from "@/lib/reading/session-voice-lock";
import {
  resolveVoiceGender,
  type VoiceGender,
} from "@/lib/reading/voice-persona";

export const FEMALE_VOICE_PREVIEW_TEXT =
  "Chào con, hôm nay cô trò mình cùng đọc sách bài Hai mươi mốt bông hoa nhé.";
export const MALE_VOICE_PREVIEW_TEXT =
  "Chào con, hôm nay thầy trò mình cùng đọc sách bài Hai mươi mốt bông hoa nhé.";

export const STATIC_VOICE_PREVIEW_RACE_MS = 80;

export interface StaticVoicePreviewEntry {
  readonly url: string;
  readonly voiceId: string;
  readonly genderVariant: VoiceGender;
  readonly text: string;
  readonly region: VoiceRegion;
  readonly modelVersion: string;
  readonly cachedSpeed: 0.9;
  readonly durationSeconds: number;
  readonly words: readonly WordTiming[];
}

export const STATIC_VOICE_PREVIEWS: readonly StaticVoicePreviewEntry[] = [
  {
    url: "/audio/voice-previews/local_north_truc_ly__female.mp3",
    voiceId: "local_north_truc_ly",
    genderVariant: "female",
    text: FEMALE_VOICE_PREVIEW_TEXT,
    region: "north",
    modelVersion: "vieneu-v3-turbo-onnx-hybrid-3.8.5",
    cachedSpeed: 0.9,
    durationSeconds: 4.052,
    words: [
      { index: 0, start: 0.17, end: 0.384 },
      { index: 1, start: 0.384, end: 0.621 },
      { index: 2, start: 0.621, end: 0.819 },
      { index: 3, start: 0.819, end: 1.018 },
      { index: 4, start: 1.018, end: 1.201 },
      { index: 5, start: 1.201, end: 1.4 },
      { index: 6, start: 1.4, end: 1.614 },
      { index: 7, start: 1.614, end: 1.828 },
      { index: 8, start: 1.828, end: 2.026 },
      { index: 9, start: 2.026, end: 2.24 },
      { index: 10, start: 2.24, end: 2.439 },
      { index: 11, start: 2.439, end: 2.638 },
      { index: 12, start: 2.638, end: 2.851 },
      { index: 13, start: 2.851, end: 3.05 },
      { index: 14, start: 3.05, end: 3.264 },
      { index: 15, start: 3.264, end: 3.463 },
      { index: 16, start: 3.463, end: 3.73 },
    ],
  },
  {
    url: "/audio/voice-previews/local_north_truc_ly__male.mp3",
    voiceId: "local_north_truc_ly",
    genderVariant: "male",
    text: MALE_VOICE_PREVIEW_TEXT,
    region: "north",
    modelVersion: "vieneu-v3-turbo-onnx-hybrid-3.8.5",
    cachedSpeed: 0.9,
    durationSeconds: 4.052,
    words: [
      { index: 0, start: 0.18, end: 0.391 },
      { index: 1, start: 0.391, end: 0.626 },
      { index: 2, start: 0.626, end: 0.822 },
      { index: 3, start: 0.822, end: 1.018 },
      { index: 4, start: 1.018, end: 1.23 },
      { index: 5, start: 1.23, end: 1.426 },
      { index: 6, start: 1.426, end: 1.638 },
      { index: 7, start: 1.638, end: 1.849 },
      { index: 8, start: 1.849, end: 2.046 },
      { index: 9, start: 2.046, end: 2.257 },
      { index: 10, start: 2.257, end: 2.454 },
      { index: 11, start: 2.454, end: 2.65 },
      { index: 12, start: 2.65, end: 2.861 },
      { index: 13, start: 2.861, end: 3.058 },
      { index: 14, start: 3.058, end: 3.269 },
      { index: 15, start: 3.269, end: 3.466 },
      { index: 16, start: 3.466, end: 3.73 },
    ],
  },
  {
    url: "/audio/voice-previews/local_north_ngoc_linh__female.mp3",
    voiceId: "local_north_ngoc_linh",
    genderVariant: "female",
    text: FEMALE_VOICE_PREVIEW_TEXT,
    region: "north",
    modelVersion: "vieneu-v3-turbo-onnx-hybrid-3.8.5",
    cachedSpeed: 0.9,
    durationSeconds: 4.408,
    words: [
      { index: 0, start: 0.17, end: 0.406 },
      { index: 1, start: 0.406, end: 0.666 },
      { index: 2, start: 0.666, end: 0.885 },
      { index: 3, start: 0.885, end: 1.104 },
      { index: 4, start: 1.104, end: 1.306 },
      { index: 5, start: 1.306, end: 1.524 },
      { index: 6, start: 1.524, end: 1.76 },
      { index: 7, start: 1.76, end: 1.995 },
      { index: 8, start: 1.995, end: 2.214 },
      { index: 9, start: 2.214, end: 2.45 },
      { index: 10, start: 2.45, end: 2.668 },
      { index: 11, start: 2.668, end: 2.887 },
      { index: 12, start: 2.887, end: 3.123 },
      { index: 13, start: 3.123, end: 3.341 },
      { index: 14, start: 3.341, end: 3.577 },
      { index: 15, start: 3.577, end: 3.796 },
      { index: 16, start: 3.796, end: 4.09 },
    ],
  },
  {
    url: "/audio/voice-previews/local_north_ngoc_linh__male.mp3",
    voiceId: "local_north_ngoc_linh",
    genderVariant: "male",
    text: MALE_VOICE_PREVIEW_TEXT,
    region: "north",
    modelVersion: "vieneu-v3-turbo-onnx-hybrid-3.8.5",
    cachedSpeed: 0.9,
    durationSeconds: 4.408,
    words: [
      { index: 0, start: 0.07, end: 0.306 },
      { index: 1, start: 0.306, end: 0.567 },
      { index: 2, start: 0.567, end: 0.786 },
      { index: 3, start: 0.786, end: 1.005 },
      { index: 4, start: 1.005, end: 1.241 },
      { index: 5, start: 1.241, end: 1.46 },
      { index: 6, start: 1.46, end: 1.696 },
      { index: 7, start: 1.696, end: 1.932 },
      { index: 8, start: 1.932, end: 2.151 },
      { index: 9, start: 2.151, end: 2.387 },
      { index: 10, start: 2.387, end: 2.606 },
      { index: 11, start: 2.606, end: 2.825 },
      { index: 12, start: 2.825, end: 3.061 },
      { index: 13, start: 3.061, end: 3.28 },
      { index: 14, start: 3.28, end: 3.516 },
      { index: 15, start: 3.516, end: 3.735 },
      { index: 16, start: 3.735, end: 4.03 },
    ],
  },
  {
    url: "/audio/voice-previews/local_north_thien_minh__female.mp3",
    voiceId: "local_north_thien_minh",
    genderVariant: "female",
    text: FEMALE_VOICE_PREVIEW_TEXT,
    region: "north",
    modelVersion: "vieneu-v3-turbo-onnx-hybrid-3.8.5",
    cachedSpeed: 0.9,
    durationSeconds: 4.497,
    words: [
      { index: 0, start: 0.14, end: 0.382 },
      { index: 1, start: 0.382, end: 0.65 },
      { index: 2, start: 0.65, end: 0.875 },
      { index: 3, start: 0.875, end: 1.1 },
      { index: 4, start: 1.1, end: 1.307 },
      { index: 5, start: 1.307, end: 1.532 },
      { index: 6, start: 1.532, end: 1.774 },
      { index: 7, start: 1.774, end: 2.017 },
      { index: 8, start: 2.017, end: 2.241 },
      { index: 9, start: 2.241, end: 2.484 },
      { index: 10, start: 2.484, end: 2.708 },
      { index: 11, start: 2.708, end: 2.933 },
      { index: 12, start: 2.933, end: 3.175 },
      { index: 13, start: 3.175, end: 3.4 },
      { index: 14, start: 3.4, end: 3.642 },
      { index: 15, start: 3.642, end: 3.867 },
      { index: 16, start: 3.867, end: 4.17 },
    ],
  },
  {
    url: "/audio/voice-previews/local_north_thien_minh__male.mp3",
    voiceId: "local_north_thien_minh",
    genderVariant: "male",
    text: MALE_VOICE_PREVIEW_TEXT,
    region: "north",
    modelVersion: "vieneu-v3-turbo-onnx-hybrid-3.8.5",
    cachedSpeed: 0.9,
    durationSeconds: 4.763,
    words: [
      { index: 0, start: 0.13, end: 0.372 },
      { index: 1, start: 0.372, end: 0.64 },
      { index: 2, start: 0.64, end: 0.864 },
      { index: 3, start: 0.864, end: 1.089 },
      { index: 4, start: 1.089, end: 1.331 },
      { index: 5, start: 1.331, end: 1.555 },
      { index: 6, start: 1.555, end: 1.797 },
      { index: 7, start: 1.797, end: 2.039 },
      { index: 8, start: 2.039, end: 2.264 },
      { index: 9, start: 2.264, end: 2.506 },
      { index: 10, start: 2.506, end: 2.73 },
      { index: 11, start: 2.73, end: 2.955 },
      { index: 12, start: 2.955, end: 3.197 },
      { index: 13, start: 3.197, end: 3.421 },
      { index: 14, start: 3.421, end: 3.663 },
      { index: 15, start: 3.663, end: 3.888 },
      { index: 16, start: 3.888, end: 4.19 },
    ],
  },
  {
    url: "/audio/voice-previews/local_central_ngoc_tran__female.mp3",
    voiceId: "local_central_ngoc_tran",
    genderVariant: "female",
    text: FEMALE_VOICE_PREVIEW_TEXT,
    region: "central",
    modelVersion: "vieneu-v3-turbo-onnx-hybrid-3.8.5",
    cachedSpeed: 0.9,
    durationSeconds: 4.852,
    words: [
      { index: 0, start: 0.21, end: 0.465 },
      { index: 1, start: 0.465, end: 0.747 },
      { index: 2, start: 0.747, end: 0.983 },
      { index: 3, start: 0.983, end: 1.22 },
      { index: 4, start: 1.22, end: 1.438 },
      { index: 5, start: 1.438, end: 1.675 },
      { index: 6, start: 1.675, end: 1.93 },
      { index: 7, start: 1.93, end: 2.184 },
      { index: 8, start: 2.184, end: 2.421 },
      { index: 9, start: 2.421, end: 2.676 },
      { index: 10, start: 2.676, end: 2.912 },
      { index: 11, start: 2.912, end: 3.149 },
      { index: 12, start: 3.149, end: 3.404 },
      { index: 13, start: 3.404, end: 3.64 },
      { index: 14, start: 3.64, end: 3.895 },
      { index: 15, start: 3.895, end: 4.132 },
      { index: 16, start: 4.132, end: 4.45 },
    ],
  },
  {
    url: "/audio/voice-previews/local_central_ngoc_tran__male.mp3",
    voiceId: "local_central_ngoc_tran",
    genderVariant: "male",
    text: MALE_VOICE_PREVIEW_TEXT,
    region: "central",
    modelVersion: "vieneu-v3-turbo-onnx-hybrid-3.8.5",
    cachedSpeed: 0.9,
    durationSeconds: 4.319,
    words: [
      { index: 0, start: 0.18, end: 0.401 },
      { index: 1, start: 0.401, end: 0.646 },
      { index: 2, start: 0.646, end: 0.851 },
      { index: 3, start: 0.851, end: 1.056 },
      { index: 4, start: 1.056, end: 1.277 },
      { index: 5, start: 1.277, end: 1.482 },
      { index: 6, start: 1.482, end: 1.703 },
      { index: 7, start: 1.703, end: 1.924 },
      { index: 8, start: 1.924, end: 2.13 },
      { index: 9, start: 2.13, end: 2.351 },
      { index: 10, start: 2.351, end: 2.556 },
      { index: 11, start: 2.556, end: 2.761 },
      { index: 12, start: 2.761, end: 2.982 },
      { index: 13, start: 2.982, end: 3.187 },
      { index: 14, start: 3.187, end: 3.408 },
      { index: 15, start: 3.408, end: 3.614 },
      { index: 16, start: 3.614, end: 3.89 },
    ],
  },
  {
    url: "/audio/voice-previews/local_central_quang_son__female.mp3",
    voiceId: "local_central_quang_son",
    genderVariant: "female",
    text: FEMALE_VOICE_PREVIEW_TEXT,
    region: "central",
    modelVersion: "vieneu-v3-turbo-onnx-hybrid-3.8.5",
    cachedSpeed: 0.9,
    durationSeconds: 5.386,
    words: [
      { index: 0, start: 0.19, end: 0.478 },
      { index: 1, start: 0.478, end: 0.796 },
      { index: 2, start: 0.796, end: 1.064 },
      { index: 3, start: 1.064, end: 1.331 },
      { index: 4, start: 1.331, end: 1.578 },
      { index: 5, start: 1.578, end: 1.845 },
      { index: 6, start: 1.845, end: 2.133 },
      { index: 7, start: 2.133, end: 2.421 },
      { index: 8, start: 2.421, end: 2.688 },
      { index: 9, start: 2.688, end: 2.976 },
      { index: 10, start: 2.976, end: 3.243 },
      { index: 11, start: 3.243, end: 3.51 },
      { index: 12, start: 3.51, end: 3.798 },
      { index: 13, start: 3.798, end: 4.065 },
      { index: 14, start: 4.065, end: 4.353 },
      { index: 15, start: 4.353, end: 4.62 },
      { index: 16, start: 4.62, end: 4.98 },
    ],
  },
  {
    url: "/audio/voice-previews/local_central_quang_son__male.mp3",
    voiceId: "local_central_quang_son",
    genderVariant: "male",
    text: MALE_VOICE_PREVIEW_TEXT,
    region: "central",
    modelVersion: "vieneu-v3-turbo-onnx-hybrid-3.8.5",
    cachedSpeed: 0.9,
    durationSeconds: 5.474,
    words: [
      { index: 0, start: 0.21, end: 0.497 },
      { index: 1, start: 0.497, end: 0.815 },
      { index: 2, start: 0.815, end: 1.082 },
      { index: 3, start: 1.082, end: 1.348 },
      { index: 4, start: 1.348, end: 1.635 },
      { index: 5, start: 1.635, end: 1.902 },
      { index: 6, start: 1.902, end: 2.189 },
      { index: 7, start: 2.189, end: 2.476 },
      { index: 8, start: 2.476, end: 2.743 },
      { index: 9, start: 2.743, end: 3.03 },
      { index: 10, start: 3.03, end: 3.297 },
      { index: 11, start: 3.297, end: 3.563 },
      { index: 12, start: 3.563, end: 3.851 },
      { index: 13, start: 3.851, end: 4.117 },
      { index: 14, start: 4.117, end: 4.404 },
      { index: 15, start: 4.404, end: 4.671 },
      { index: 16, start: 4.671, end: 5.03 },
    ],
  },
  {
    url: "/audio/voice-previews/local_south_thuc_doan__female.mp3",
    voiceId: "local_south_thuc_doan",
    genderVariant: "female",
    text: FEMALE_VOICE_PREVIEW_TEXT,
    region: "south",
    modelVersion: "vieneu-v3-turbo-onnx-hybrid-3.8.5",
    cachedSpeed: 0.9,
    durationSeconds: 4.674,
    words: [
      { index: 0, start: 0.13, end: 0.381 },
      { index: 1, start: 0.381, end: 0.658 },
      { index: 2, start: 0.658, end: 0.891 },
      { index: 3, start: 0.891, end: 1.123 },
      { index: 4, start: 1.123, end: 1.338 },
      { index: 5, start: 1.338, end: 1.571 },
      { index: 6, start: 1.571, end: 1.821 },
      { index: 7, start: 1.821, end: 2.072 },
      { index: 8, start: 2.072, end: 2.304 },
      { index: 9, start: 2.304, end: 2.555 },
      { index: 10, start: 2.555, end: 2.788 },
      { index: 11, start: 2.788, end: 3.02 },
      { index: 12, start: 3.02, end: 3.271 },
      { index: 13, start: 3.271, end: 3.504 },
      { index: 14, start: 3.504, end: 3.754 },
      { index: 15, start: 3.754, end: 3.987 },
      { index: 16, start: 3.987, end: 4.3 },
    ],
  },
  {
    url: "/audio/voice-previews/local_south_thuc_doan__male.mp3",
    voiceId: "local_south_thuc_doan",
    genderVariant: "male",
    text: MALE_VOICE_PREVIEW_TEXT,
    region: "south",
    modelVersion: "vieneu-v3-turbo-onnx-hybrid-3.8.5",
    cachedSpeed: 0.9,
    durationSeconds: 4.586,
    words: [
      { index: 0, start: 0.18, end: 0.421 },
      { index: 1, start: 0.421, end: 0.688 },
      { index: 2, start: 0.688, end: 0.912 },
      { index: 3, start: 0.912, end: 1.136 },
      { index: 4, start: 1.136, end: 1.378 },
      { index: 5, start: 1.378, end: 1.602 },
      { index: 6, start: 1.602, end: 1.843 },
      { index: 7, start: 1.843, end: 2.084 },
      { index: 8, start: 2.084, end: 2.308 },
      { index: 9, start: 2.308, end: 2.55 },
      { index: 10, start: 2.55, end: 2.774 },
      { index: 11, start: 2.774, end: 2.998 },
      { index: 12, start: 2.998, end: 3.239 },
      { index: 13, start: 3.239, end: 3.463 },
      { index: 14, start: 3.463, end: 3.704 },
      { index: 15, start: 3.704, end: 3.928 },
      { index: 16, start: 3.928, end: 4.23 },
    ],
  },
  {
    url: "/audio/voice-previews/local_south_my_duyen__female.mp3",
    voiceId: "local_south_my_duyen",
    genderVariant: "female",
    text: FEMALE_VOICE_PREVIEW_TEXT,
    region: "south",
    modelVersion: "vieneu-v3-turbo-onnx-hybrid-3.8.5",
    cachedSpeed: 0.9,
    durationSeconds: 5.297,
    words: [
      { index: 0, start: 0.26, end: 0.539 },
      { index: 1, start: 0.539, end: 0.849 },
      { index: 2, start: 0.849, end: 1.108 },
      { index: 3, start: 1.108, end: 1.368 },
      { index: 4, start: 1.368, end: 1.607 },
      { index: 5, start: 1.607, end: 1.867 },
      { index: 6, start: 1.867, end: 2.146 },
      { index: 7, start: 2.146, end: 2.425 },
      { index: 8, start: 2.425, end: 2.685 },
      { index: 9, start: 2.685, end: 2.964 },
      { index: 10, start: 2.964, end: 3.224 },
      { index: 11, start: 3.224, end: 3.483 },
      { index: 12, start: 3.483, end: 3.762 },
      { index: 13, start: 3.762, end: 4.022 },
      { index: 14, start: 4.022, end: 4.301 },
      { index: 15, start: 4.301, end: 4.561 },
      { index: 16, start: 4.561, end: 4.91 },
    ],
  },
  {
    url: "/audio/voice-previews/local_south_my_duyen__male.mp3",
    voiceId: "local_south_my_duyen",
    genderVariant: "male",
    text: MALE_VOICE_PREVIEW_TEXT,
    region: "south",
    modelVersion: "vieneu-v3-turbo-onnx-hybrid-3.8.5",
    cachedSpeed: 0.9,
    durationSeconds: 5.652,
    words: [
      { index: 0, start: 0.24, end: 0.54 },
      { index: 1, start: 0.54, end: 0.873 },
      { index: 2, start: 0.873, end: 1.151 },
      { index: 3, start: 1.151, end: 1.43 },
      { index: 4, start: 1.43, end: 1.731 },
      { index: 5, start: 1.731, end: 2.009 },
      { index: 6, start: 2.009, end: 2.31 },
      { index: 7, start: 2.31, end: 2.61 },
      { index: 8, start: 2.61, end: 2.889 },
      { index: 9, start: 2.889, end: 3.189 },
      { index: 10, start: 3.189, end: 3.468 },
      { index: 11, start: 3.468, end: 3.747 },
      { index: 12, start: 3.747, end: 4.047 },
      { index: 13, start: 4.047, end: 4.326 },
      { index: 14, start: 4.326, end: 4.626 },
      { index: 15, start: 4.626, end: 4.905 },
      { index: 16, start: 4.905, end: 5.28 },
    ],
  },
  {
    url: "/audio/voice-previews/local_south_thai_son__female.mp3",
    voiceId: "local_south_thai_son",
    genderVariant: "female",
    text: FEMALE_VOICE_PREVIEW_TEXT,
    region: "south",
    modelVersion: "vieneu-v3-turbo-onnx-hybrid-3.8.5",
    cachedSpeed: 0.9,
    durationSeconds: 5.208,
    words: [
      { index: 0, start: 0.07, end: 0.356 },
      { index: 1, start: 0.356, end: 0.673 },
      { index: 2, start: 0.673, end: 0.938 },
      { index: 3, start: 0.938, end: 1.204 },
      { index: 4, start: 1.204, end: 1.449 },
      { index: 5, start: 1.449, end: 1.715 },
      { index: 6, start: 1.715, end: 2.001 },
      { index: 7, start: 2.001, end: 2.287 },
      { index: 8, start: 2.287, end: 2.552 },
      { index: 9, start: 2.552, end: 2.838 },
      { index: 10, start: 2.838, end: 3.104 },
      { index: 11, start: 3.104, end: 3.369 },
      { index: 12, start: 3.369, end: 3.655 },
      { index: 13, start: 3.655, end: 3.921 },
      { index: 14, start: 3.921, end: 4.207 },
      { index: 15, start: 4.207, end: 4.472 },
      { index: 16, start: 4.472, end: 4.83 },
    ],
  },
  {
    url: "/audio/voice-previews/local_south_thai_son__male.mp3",
    voiceId: "local_south_thai_son",
    genderVariant: "male",
    text: MALE_VOICE_PREVIEW_TEXT,
    region: "south",
    modelVersion: "vieneu-v3-turbo-onnx-hybrid-3.8.5",
    cachedSpeed: 0.9,
    durationSeconds: 4.941,
    words: [
      { index: 0, start: 0.07, end: 0.338 },
      { index: 1, start: 0.338, end: 0.635 },
      { index: 2, start: 0.635, end: 0.884 },
      { index: 3, start: 0.884, end: 1.133 },
      { index: 4, start: 1.133, end: 1.401 },
      { index: 5, start: 1.401, end: 1.65 },
      { index: 6, start: 1.65, end: 1.918 },
      { index: 7, start: 1.918, end: 2.186 },
      { index: 8, start: 2.186, end: 2.435 },
      { index: 9, start: 2.435, end: 2.703 },
      { index: 10, start: 2.703, end: 2.952 },
      { index: 11, start: 2.952, end: 3.201 },
      { index: 12, start: 3.201, end: 3.469 },
      { index: 13, start: 3.469, end: 3.718 },
      { index: 14, start: 3.718, end: 3.986 },
      { index: 15, start: 3.986, end: 4.235 },
      { index: 16, start: 4.235, end: 4.57 },
    ],
  },
];

function normalizePreviewLookupText(raw: string): string {
  return raw.normalize("NFC").trim().replace(/\s+/gu, " ");
}

const PREVIEW_LOOKUP_MAP: ReadonlyMap<string, StaticVoicePreviewEntry> =
  new Map(
    STATIC_VOICE_PREVIEWS.map((entry) => [
      `${entry.voiceId}::${normalizePreviewLookupText(entry.text)}`,
      entry,
    ]),
  );

const staticPreviewBlobCache = new Map<string, Blob>();
const inFlightStaticPreviewFetches = new Map<string, Promise<Blob | null>>();
let staticVoicePreviewTestOverride: boolean | null = null;
let cacheEpoch = 0;

/**
 * In Vitest (`process.env.NODE_ENV === "test"`), static preview interception is
 * disabled by default so JSDOM unit tests exercising backend timeouts/fallbacks
 * remain untouched unless they explicitly opt in via `setStaticVoicePreviewEnabledForTests(true)`.
 */
export function setStaticVoicePreviewEnabledForTests(
  enabled: boolean | null,
): void {
  staticVoicePreviewTestOverride = enabled;
}

export function isStaticVoicePreviewEnabled(): boolean {
  if (staticVoicePreviewTestOverride !== null) {
    return staticVoicePreviewTestOverride;
  }
  return process.env.NODE_ENV !== "test";
}

export function resetStaticVoicePreviewsForTests(): void {
  cacheEpoch += 1;
  staticVoicePreviewTestOverride = null;
  staticPreviewBlobCache.clear();
  inFlightStaticPreviewFetches.clear();
}

export function resolveStaticVoicePreview(
  voiceId: string | null | undefined,
  text: string,
): StaticVoicePreviewEntry | null {
  const cleanVoiceId = (voiceId ?? "").trim();
  if (!cleanVoiceId || !text) return null;
  const normalizedText = normalizePreviewLookupText(text);
  if (!normalizedText) return null;
  return PREVIEW_LOOKUP_MAP.get(`${cleanVoiceId}::${normalizedText}`) ?? null;
}

function createAbortError(): Error {
  return new DOMException("Audio playback was stopped.", "AbortError");
}

export async function fetchStaticVoicePreviewBlob(
  entry: StaticVoicePreviewEntry,
  signal?: AbortSignal,
): Promise<Blob | null> {
  if (signal?.aborted) {
    throw createAbortError();
  }
  const cached = staticPreviewBlobCache.get(entry.url);
  if (cached) {
    return cached;
  }
  if (typeof fetch !== "function") {
    return null;
  }

  let shared = inFlightStaticPreviewFetches.get(entry.url);
  if (!shared) {
    const epochAtStart = cacheEpoch;
    let task: Promise<Blob | null> | null = null;
    task = (async (): Promise<Blob | null> => {
      try {
        const response = await fetch(entry.url, {
          method: "GET",
          credentials: "omit",
        });
        if (!response.ok) return null;
        const contentType = (
          response.headers.get("content-type") ?? ""
        ).toLowerCase();
        if (contentType.includes("text/html")) {
          return null;
        }
        const rawBlob = await response.blob();
        if (!rawBlob.size) return null;
        const audioBlob = rawBlob.type.startsWith("audio/")
          ? rawBlob
          : new Blob([rawBlob], { type: "audio/mpeg" });
        if (cacheEpoch === epochAtStart) {
          staticPreviewBlobCache.set(entry.url, audioBlob);
        }
        return audioBlob;
      } catch {
        return null;
      } finally {
        if (task && inFlightStaticPreviewFetches.get(entry.url) === task) {
          inFlightStaticPreviewFetches.delete(entry.url);
        }
      }
    })();
    inFlightStaticPreviewFetches.set(entry.url, task);
    shared = task;
  }

  if (!signal) {
    return shared;
  }

  const activeTask = shared;
  return new Promise<Blob | null>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      reject(createAbortError());
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    void activeTask.then(
      (blob) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(blob);
      },
      () => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(null);
      },
    );
  });
}

export async function warmStaticVoicePreview(
  voiceId: string | null | undefined,
  text?: string,
): Promise<boolean> {
  if (!isStaticVoicePreviewEnabled() || typeof window === "undefined") {
    return false;
  }
  const cleanVoiceId = (voiceId ?? "").trim();
  if (!cleanVoiceId) return false;

  if (text !== undefined) {
    const entry = resolveStaticVoicePreview(cleanVoiceId, text);
    if (!entry) return false;
    const blob = await fetchStaticVoicePreviewBlob(entry);
    return blob !== null;
  }

  const preferredGender = resolveVoiceGender(cleanVoiceId);
  const matching = STATIC_VOICE_PREVIEWS.filter(
    (entry) => entry.voiceId === cleanVoiceId,
  ).sort((a, b) =>
    a.genderVariant === preferredGender
      ? -1
      : b.genderVariant === preferredGender
        ? 1
        : 0,
  );
  if (!matching.length) return false;
  const results = await Promise.all(
    matching.map((entry) => fetchStaticVoicePreviewBlob(entry)),
  );
  return results.some((blob) => blob !== null);
}
