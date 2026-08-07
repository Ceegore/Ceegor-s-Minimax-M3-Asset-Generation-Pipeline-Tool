# Uninstalling MiniMax Asset Tool

## Portable installation

The portable release is a self-contained folder (`MiniMaxAssetTool-<version>-x64`).
To uninstall it:

1. Close the application if it is running.
2. Delete the entire extracted application folder.

No registry entries, services, or system-wide components are created by the
portable release.

## Installed via `Install-MiniMax-Asset-Tool.cmd`

The installer copies the same portable folder into a target directory of your
choice. To uninstall, close the application and delete that directory.

## User data

Application data is stored in your local configuration directory (the folder
shown in the application's settings, holding `settings.json`, `providers.json`,
and job state). Delete this directory only if you want to remove all saved
settings and provider credentials. API keys stored there are removed with it.

Debug logs you created via the debug log feature are ordinary files at the
location you chose; delete them separately if desired.

## What is NOT removed automatically

- Files you generated or downloaded remain wherever you saved them.
- Nothing is sent anywhere during uninstallation; the process is fully local.
