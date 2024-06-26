import path from "path";
import * as vscode from "vscode";
import { showQuickPick } from "../common/quick-pick";

import { getBuildConfigurations, getSchemes } from "../common/cli/scripts";
import { ExtensionContext } from "../common/commands";
import { ExtensionError } from "../common/errors";
import { createDirectory, findFilesRecursive, isFileExists, removeDirectory } from "../common/files";
import { commonLogger } from "../common/logger";
import { getWorkspaceConfig } from "../common/config";

const DEFAULT_CONFIGURATION = "Debug";

type SelectedDestination = {
  type: "simulator" | "device";
  udid: string;
};

/**
 * Ask user to select simulator or device to run on
 */
export async function askDestinationToRunOn(context: ExtensionContext): Promise<SelectedDestination> {
  // If we have cached desination, use it
  const simulators = await context.simulatorsManager.getSimulators();
  const devices = await context.devicesManager.getDevices();
  const cachedDestination = context.getWorkspaceState("build.xcodeDestination");
  if (cachedDestination) {
    if (cachedDestination.type === "simulator") {
      const simulator = simulators.find((simulator) => simulator.udid === cachedDestination.udid);
      if (simulator) {
        return {
          type: "simulator",
          udid: simulator.udid,
        };
      }
    }
    if (cachedDestination.type === "device") {
      const device = devices.find((device) => device.udid === cachedDestination.udid);
      if (device) {
        return {
          type: "device",
          udid: device.udid,
        };
      }
    }
  }

  const selected = await showQuickPick<SelectedDestination>({
    title: "Select destination to run on",
    items: [
      ...simulators.map((simulator) => {
        return {
          label: simulator.label,
          iconPath: new vscode.ThemeIcon("vm"),
          context: {
            type: "simulator" as const,
            udid: simulator.udid,
          },
        };
      }),
      ...devices.map((device) => {
        return {
          label: device.label,
          iconPath: new vscode.ThemeIcon("device-mobile"),
          context: {
            type: "device" as const,
            udid: device.udid,
          },
        };
      }),
    ],
  });

  context.updateWorkspaceState("build.xcodeDestination", {
    type: selected.context.type,
    udid: selected.context.udid,
  });

  return selected.context;
}

export async function getDestinationByUdid(
  context: ExtensionContext,
  options: { udid: string },
): Promise<SelectedDestination> {
  const simulators = await context.simulatorsManager.getSimulators();
  const devices = await context.devicesManager.getDevices();

  for (const simulator of simulators) {
    if (simulator.udid === options.udid) {
      return {
        type: "simulator",
        udid: simulator.udid,
      };
    }
  }

  for (const device of devices) {
    if (device.udid === options.udid) {
      return {
        type: "device",
        udid: device.udid,
      };
    }
  }

  throw new ExtensionError("Destination not found", {
    context: {
      udid: options.udid,
    },
  });
}

/**
 * Ask user to select scheme to build
 */
export async function askScheme(options: { title?: string; xcworkspace: string }): Promise<string> {
  const schemes = await getSchemes({
    xcworkspace: options.xcworkspace,
  });

  const scheme = await showQuickPick({
    title: options?.title ?? "Select scheme to build",
    items: schemes.map((scheme) => {
      return {
        label: scheme.name,
        context: {
          scheme: scheme,
        },
      };
    }),
  });

  return scheme.context.scheme.name;
}

/**
 * It's absolute path to current opened workspace
 */
export function getWorkspacePath(): string {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
  if (!workspaceFolder) {
    throw new ExtensionError("No workspace folder found");
  }
  return workspaceFolder;
}

/**
 * Prepare storage path for the extension. It's a folder where we store all intermediate files
 */
export async function prepareStoragePath(context: ExtensionContext): Promise<string> {
  const storagePath = context.storageUri?.fsPath;
  if (!storagePath) {
    throw new ExtensionError("No storage path found");
  }
  // Creatre folder at storagePath, because vscode doesn't create it automatically
  await createDirectory(storagePath);
  return storagePath;
}

/**
 * Prepare bundle directory for the given schema in the storage path
 */
export async function prepareBundleDir(context: ExtensionContext, schema: string): Promise<string> {
  const storagePath = await prepareStoragePath(context);

  const bundleDir = path.join(storagePath, "bundle", schema);

  // Remove old bundle if exists
  await removeDirectory(bundleDir);

  // Remove old .xcresult if exists
  const xcresult = path.join(storagePath, "bundle", `${schema}.xcresult`);
  await removeDirectory(xcresult);

  return bundleDir;
}

export function getCurrentXcodeWorkspacePath(context: ExtensionContext): string | undefined {
  const configPath = getWorkspaceConfig("build.xcodeWorkspacePath");
  if (configPath) {
    context.updateWorkspaceState("build.xcodeWorkspacePath", undefined);
    if (path.isAbsolute(configPath)) {
      return configPath;
    } else {
      return path.join(getWorkspacePath(), configPath);
    }
  }

  const cachedPath = context.getWorkspaceState("build.xcodeWorkspacePath");
  if (cachedPath) {
    return cachedPath;
  }

  return undefined;
}

export async function askXcodeWorkspacePath(context: ExtensionContext): Promise<string> {
  const current = getCurrentXcodeWorkspacePath(context);
  if (current) {
    return current;
  }

  const selectedPath = await selectXcodeWorkspace({
    autoselect: true,
  });

  context.updateWorkspaceState("build.xcodeWorkspacePath", selectedPath);
  context.refreshBuildView();
  return selectedPath;
}

export async function askConfiguration(
  context: ExtensionContext,
  options: {
    xcworkspace: string;
  },
): Promise<string> {
  return await context.withCache("build.xcodeConfiguration", async () => {
    // Fetch all configurations
    const configurations = await getBuildConfigurations({
      xcworkspace: options.xcworkspace,
    });

    // Use default configuration if no configurations found
    if (configurations.length === 0) {
      return DEFAULT_CONFIGURATION;
    }

    // Use default configuration if it exists
    if (configurations.some((configuration) => configuration.name === DEFAULT_CONFIGURATION)) {
      return DEFAULT_CONFIGURATION;
    }

    // Give user a choice to select configuration if we don't know wich one to use
    const selected = await showQuickPick({
      title: "Select configuration",
      items: configurations.map((configuration) => {
        return {
          label: configuration.name,
          context: {
            configuration,
          },
        };
      }),
    });
    return selected.context.configuration.name;
  });
}

/**
 * Detect xcode workspace in the given directory
 */
async function detectXcodeWorkspacesPaths(): Promise<string[]> {
  const workspace = getWorkspacePath();

  // Get all files that end with .xcworkspace (4 depth)
  const paths = await findFilesRecursive({
    directory: workspace,
    depth: 4,
    matcher: (file) => {
      return file.name.endsWith(".xcworkspace");
    },
  });
  return paths;
}

/**
 * Find xcode workspace in the given directory and ask user to select it
 */
export async function selectXcodeWorkspace(options: { autoselect: boolean }): Promise<string> {
  const workspacePath = getWorkspacePath();

  // Get all files that end with .xcworkspace (4 depth)
  const paths = await detectXcodeWorkspacesPaths();

  // No files, nothing to do
  if (paths.length === 0) {
    throw new ExtensionError("No xcode workspaces found", {
      context: {
        cwd: workspacePath,
      },
    });
  }

  // One file, use it and save it to the cache
  if (paths.length === 1 && options.autoselect) {
    const path = paths[0];
    commonLogger.log("Xcode workspace was detected", {
      workspace: workspacePath,
      path: path,
    });
    return path;
  }

  const podfilePath = path.join(workspacePath, "Podfile");
  const isCocoaProject = await isFileExists(podfilePath);

  // More then one, ask user to select
  const selected = await showQuickPick({
    title: "Select xcode workspace",
    items: paths
      .sort((a, b) => {
        // Sort by depth to show less nested paths first
        const aDepth = a.split(path.sep).length;
        const bDepth = b.split(path.sep).length;
        return aDepth - bDepth;
      })
      .map((xwPath) => {
        // show only relative path, to make it more readable
        const relativePath = path.relative(workspacePath, xwPath);
        const parentDir = path.dirname(relativePath);

        const isInRootDir = parentDir === ".";
        const isCocoaPods = isInRootDir && isCocoaProject;

        let detail: string | undefined;
        if (isCocoaPods && isInRootDir) {
          detail = "CocoaPods (recommended)";
        } else if (!isInRootDir && parentDir.endsWith(".xcodeproj")) {
          detail = "Xcode";
        }
        // todo: add workspace with multiple projects

        return {
          label: relativePath,
          detail: detail,
          context: {
            path: xwPath,
          },
        };
      }),
  });
  return selected.context.path;
}

export async function restartSwiftLSP() {
  // Restart SourceKit Language Server
  try {
    await vscode.commands.executeCommand("swift.restartLSPServer");
  } catch (error) {
    commonLogger.warn("Error restarting SourceKit Language Server", {
      error: error,
    });
  }
}
