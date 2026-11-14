# Local Legend mobile app

Expo (SDK 58, Expo Router, TypeScript) app built with EAS development builds, internal preview builds, and EAS Update.

```bash
npm install
npm start                                 # Metro for the development build (dev client)
npm run build:preview:android             # EAS cloud build (see eas.json for profiles)
npm run update:preview -- "What changed"  # publish an OTA update to the preview channel
```

See `../docs/` for the full test-distribution workflow.
