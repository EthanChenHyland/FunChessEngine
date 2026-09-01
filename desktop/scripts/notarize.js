"use strict";

const path = require("path");

module.exports = async function notarizeMacBuild(context) {
  if (context.electronPlatformName !== "darwin") return;

  const appleId = process.env.APPLE_ID;
  const appleIdPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD;
  const teamId = process.env.APPLE_TEAM_ID;
  if (!appleId || !appleIdPassword || !teamId) {
    console.log("Skipping notarization: APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, and APPLE_TEAM_ID are not all set.");
    return;
  }

  const { notarize } = require("@electron/notarize");
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  await notarize({
    tool: "notarytool",
    appBundleId: "dev.funchessengine.enginelab",
    appPath,
    appleId,
    appleIdPassword,
    teamId,
  });
};
