# Uninstalling MiniMax Asset Tool

## Portable version

1. Close MiniMax Asset Tool.
2. Confirm that no generation or local-processing job is still running.
3. Delete the extracted `MiniMaxAssetTool-<version>-x64` application folder.
4. Delete manually created shortcuts if present.

Generated assets and user-selected project folders are not deleted automatically.

## Per-user installed version

1. Close MiniMax Asset Tool.
2. Delete the application directory under the current user's local application data directory, or use the supplied uninstaller when a future signed installer provides one.
3. Remove the Desktop and Start Menu shortcuts.
4. Optionally remove application settings and local state from the documented user-profile location.

Before deleting local state, back up any configuration or history the user wants to retain. API credentials stored through Windows DPAPI become unusable when their associated encrypted state is deleted.
