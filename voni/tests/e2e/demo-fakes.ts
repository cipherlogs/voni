/**
 * The browser launch the cascade demo rig needs: a real Chromium with a fake
 * microphone. The managed-era fakes (fake AssemblyAI socket, demo mint, tool
 * routes, started call) are gone with their specs (demo-verification 01); the
 * cascade rig owns its own service fake in `cascade-fake-server.ts`.
 */

export const DEMO_TEST_USE = {
  permissions: ["microphone", "clipboard-read", "clipboard-write"],
  ignoreHTTPSErrors: true,
  launchOptions: {
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
  },
};
