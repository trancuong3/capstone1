---
name: viread-mobile
description: "Use for ViRead Android/APK, Expo, or React Native work."
---
Packaging/architecture strategy or TWA-vs-Capacitor-vs-Expo tradeoffs → `viread-android-build`. Concrete APK preparation, permissions, local build, install, or runtime verification after the strategy is chosen → `viread-android-apk`. Load both only when the task explicitly includes both strategy selection and implementation. Expo → open only the matching `expo-*` skill. React Native optimization → `vercel-react-native-skills`. Never load the full Expo set.
