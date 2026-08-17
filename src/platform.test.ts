import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  PlatformCommand,
  PlatformCommandResult,
  PlatformCommandResultRunner,
  PlatformCommandRunner,
  SupportedPlatform,
} from "./platform";
import { createPlatform, UnsupportedPlatformError, validateWorkingDirectory } from "./platform";

const posixHome = "/Users/example";
const windowsHome = "C:\\Users\\Example";

function windowsSchedulerResult(
  command: PlatformCommand,
  installed: boolean,
  enabled = true,
): PlatformCommandResult {
  if (command.executable.toLowerCase().endsWith("\\powershell.exe")) {
    return {
      exitCode: installed ? (enabled ? 0 : 4) : 3,
      stderr: "",
      stdout: "",
    };
  }
  const missing = command.arguments[0] === "/Query" && !installed;
  return {
    exitCode: missing ? 1 : 0,
    stderr: missing ? "ERROR: No se encuentra el archivo especificado." : "",
    stdout: "",
  };
}

test("working-directory validation accepts directories and rejects files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quest-working-directory-"));
  const filePath = join(directory, "file");
  try {
    await writeFile(filePath, "not a directory");
    await expect(validateWorkingDirectory(directory)).resolves.toBeUndefined();
    await expect(validateWorkingDirectory(filePath)).rejects.toThrow(
      `working directory is not a directory: ${filePath}`,
    );
    await expect(validateWorkingDirectory(join(directory, "missing"))).rejects.toThrow(
      "working directory is not accessible",
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

describe("Windows executable replacement", () => {
  test("renames the running binary aside before moving the new binary into place", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quest-windows-upgrade-"));
    const destination = join(directory, "quest.exe");
    const previousExecutable = `${destination}.previous`;
    const stagingDirectory = join(directory, ".quest-upgrade-current");
    const stagedExecutable = join(stagingDirectory, "quest.exe");
    try {
      await mkdir(stagingDirectory);
      await writeFile(destination, "old binary");
      await writeFile(stagedExecutable, "new binary");
      const platform = createPlatform({
        environment: {},
        homeDirectory: windowsHome,
        platform: "win32",
      });

      await expect(
        platform.replaceExecutable?.({
          destination,
          previousExecutable,
          stagedExecutable,
          temporaryDirectory: stagingDirectory,
        }),
      ).resolves.toBe("replaced");
      expect(await readFile(destination, "utf8")).toBe("new binary");
      expect(await readFile(previousExecutable, "utf8")).toBe("old binary");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("leaves both binaries in place and gives an exact PowerShell command when the move fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quest-windows-upgrade-failure-"));
    const destination = join(directory, "quest.exe");
    const previousExecutable = `${destination}.previous`;
    const stagingDirectory = join(directory, ".quest-upgrade-current");
    const stagedExecutable = join(stagingDirectory, "quest.exe");
    try {
      await mkdir(stagingDirectory);
      await writeFile(destination, "old binary");
      const platform = createPlatform({
        environment: {},
        homeDirectory: windowsHome,
        platform: "win32",
      });

      await expect(
        platform.replaceExecutable?.({
          destination,
          previousExecutable,
          stagedExecutable,
          temporaryDirectory: stagingDirectory,
        }),
      ).rejects.toThrow(
        `the previous binary remains at ${previousExecutable} and the new binary remains at ${stagedExecutable}. Exit every quest process, then finish the upgrade in PowerShell with: Move-Item -LiteralPath '${stagedExecutable}' -Destination '${destination}' -Force`,
      );
      expect(await readFile(previousExecutable, "utf8")).toBe("old binary");
      await expect(stat(destination)).rejects.toThrow();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});

describe("process holder inspection", () => {
  test("does not pass missing optional paths to lsof", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quest-process-probe-"));
    const databasePath = join(directory, "quest.db");
    const commands: PlatformCommand[] = [];
    try {
      await writeFile(databasePath, "database");
      const platform = createPlatform({
        platform: "linux",
        homeDirectory: "/home/example",
        environment: {},
        runCommandAndWait: (command) => {
          commands.push(command);
          return Promise.resolve({ exitCode: 1, stderr: "", stdout: "" });
        },
      });

      await expect(
        platform.inspectProcessesHoldingPaths?.([databasePath, `${databasePath}.ownership.sqlite`]),
      ).resolves.toEqual({ available: true, holders: [] });
      expect(commands).toHaveLength(1);
      expect(commands[0]?.arguments).toEqual(["-nP", "-Fpcn", "--", databasePath]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("uses handle.exe to report Windows file holders", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quest-windows-process-probe-"));
    const databasePath = join(directory, "quest.db");
    const commands: PlatformCommand[] = [];
    try {
      await writeFile(databasePath, "database");
      const platform = createPlatform({
        platform: "win32",
        homeDirectory: windowsHome,
        environment: {},
        runCommandAndWait: (command) => {
          commands.push(command);
          return Promise.resolve({
            exitCode: 0,
            stderr: "",
            stdout: `quest.exe pid: 42 type: File 1A0: ${databasePath}\n`,
          });
        },
      });

      await expect(platform.inspectProcessesHoldingPaths?.([databasePath])).resolves.toEqual({
        available: true,
        holders: [{ command: "quest.exe", paths: [databasePath], pid: 42 }],
      });
      expect(commands[0]).toEqual({
        arguments: ["-nobanner", databasePath],
        executable: "handle.exe",
        timeout_ms: 5_000,
        waitForExit: true,
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("preserves known Windows holders when another path probe fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quest-windows-partial-process-probe-"));
    const databasePath = join(directory, "quest.db");
    const ownershipDatabasePath = join(directory, "quest.db.ownership.sqlite");
    const commands: PlatformCommand[] = [];
    try {
      await writeFile(databasePath, "database");
      await writeFile(ownershipDatabasePath, "ownership");
      const platform = createPlatform({
        platform: "win32",
        homeDirectory: windowsHome,
        environment: {},
        runCommandAndWait: (command) => {
          commands.push(command);
          const path = command.arguments[command.arguments.length - 1];
          return Promise.resolve(
            path === databasePath
              ? {
                  exitCode: 0,
                  stderr: "",
                  stdout: `quest.exe pid: 42 type: File 1A0: ${databasePath}\n`,
                }
              : { exitCode: 5, stderr: "access denied", stdout: "" },
          );
        },
      });

      await expect(
        platform.inspectProcessesHoldingPaths?.([databasePath, ownershipDatabasePath]),
      ).resolves.toEqual({
        available: false,
        detail: "handle.exe returned exit 5: access denied",
        holders: [{ command: "quest.exe", paths: [databasePath], pid: 42 }],
      });
      expect(commands).toHaveLength(2);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});

describe("platform directories", () => {
  test("resolves the macOS directory layout", () => {
    const platform = createPlatform({
      platform: "darwin",
      homeDirectory: posixHome,
      environment: {},
    });

    expect(platform.directories).toEqual({
      config: "/Users/example/.config/quest",
      state: "/Users/example/.local/state/quest",
      evidence: "/Users/example/.local/state/quest/evidence",
      backup: "/Users/example/Backups/quest",
      install: "/Users/example/.local/bin",
      executable: "/Users/example/.local/bin/quest",
    });
    expect(platform.scheduler.kind).toBe("launchd");
  });

  test("resolves Linux XDG directories", () => {
    const platform = createPlatform({
      platform: "linux",
      homeDirectory: "/home/example",
      environment: {
        XDG_CONFIG_HOME: "/var/example/config",
        XDG_STATE_HOME: "/var/example/state",
      },
    });

    expect(platform.directories).toEqual({
      config: "/var/example/config/quest",
      state: "/var/example/state/quest",
      evidence: "/var/example/state/quest/evidence",
      backup: "/home/example/Backups/quest",
      install: "/home/example/.local/bin",
      executable: "/home/example/.local/bin/quest",
    });
    expect(platform.scheduler.kind).toBe("systemd");
  });

  test("falls back when Linux XDG directories are empty or relative", () => {
    const platform = createPlatform({
      platform: "linux",
      homeDirectory: "/home/example",
      environment: {
        XDG_CONFIG_HOME: "",
        XDG_STATE_HOME: "relative/state",
      },
    });

    expect(platform.directories.config).toBe("/home/example/.config/quest");
    expect(platform.directories.state).toBe("/home/example/.local/state/quest");
  });

  test("resolves Windows directories from application data variables", () => {
    const platform = createPlatform({
      platform: "win32",
      homeDirectory: windowsHome,
      environment: {
        APPDATA: "D:\\Profiles\\Example\\Roaming",
        LOCALAPPDATA: "D:\\Profiles\\Example\\Local",
      },
    });

    expect(platform.directories).toEqual({
      config: "D:\\Profiles\\Example\\Roaming\\quest",
      state: "D:\\Profiles\\Example\\Local\\quest",
      evidence: "D:\\Profiles\\Example\\Local\\quest\\evidence",
      backup: "C:\\Users\\Example\\Backups\\quest",
      install: "D:\\Profiles\\Example\\Local\\Programs\\quest",
      executable: "D:\\Profiles\\Example\\Local\\Programs\\quest\\quest.exe",
    });
    expect(platform.scheduler.kind).toBe("schtasks");
  });

  test("falls back to conventional Windows application data directories", () => {
    const platform = createPlatform({
      platform: "win32",
      homeDirectory: windowsHome,
      environment: {
        APPDATA: "relative\\roaming",
        LOCALAPPDATA: "",
      },
    });

    expect(platform.directories.config).toBe("C:\\Users\\Example\\AppData\\Roaming\\quest");
    expect(platform.directories.state).toBe("C:\\Users\\Example\\AppData\\Local\\quest");
  });

  test("reads Windows application data variables case-insensitively", () => {
    const platform = createPlatform({
      platform: "win32",
      homeDirectory: windowsHome,
      environment: {
        AppData: "D:\\Profiles\\Example\\Roaming",
        LocalAppData: "D:\\Profiles\\Example\\Local",
      },
    });

    expect(platform.directories.config).toBe("D:\\Profiles\\Example\\Roaming\\quest");
    expect(platform.directories.state).toBe("D:\\Profiles\\Example\\Local\\quest");
    expect(platform.directories.install).toBe("D:\\Profiles\\Example\\Local\\Programs\\quest");
  });

  test("rejects unsupported platforms and relative home directories", () => {
    expect(() =>
      createPlatform({
        platform: "freebsd",
        homeDirectory: "/home/example",
        environment: {},
      }),
    ).toThrow(UnsupportedPlatformError);
    expect(() =>
      createPlatform({
        platform: "linux",
        homeDirectory: "relative/home",
        environment: {},
      }),
    ).toThrow("home directory must be absolute");
  });
});

describe("evidence opener", () => {
  test("uses the native macOS opener with an absolute path", async () => {
    const commands: PlatformCommand[] = [];
    const runCommand: PlatformCommandRunner = (command) => {
      commands.push(command);
      return Promise.resolve();
    };
    const platform = createPlatform({
      platform: "darwin",
      homeDirectory: posixHome,
      environment: {},
      workingDirectory: "/work/quest",
      runCommand,
    });

    const opener = platform.openEvidence;
    if (opener === undefined || platform.evidenceOpenCommand === undefined) {
      throw new Error("macOS evidence opener is missing");
    }
    expect(platform.evidenceOpenCommand("frames/first.txt")).toEqual({
      arguments: ["/work/quest/frames/first.txt"],
      executable: "open",
    });
    await opener("frames/first.txt");
    expect(commands).toEqual([{ arguments: ["/work/quest/frames/first.txt"], executable: "open" }]);
  });

  test("uses rundll32 on Windows and rejects an empty evidence path", () => {
    const platform = createPlatform({
      platform: "win32",
      homeDirectory: windowsHome,
      environment: { SystemRoot: "D:\\Windows" },
      workingDirectory: "C:\\work\\quest",
    });
    const command = platform.evidenceOpenCommand;
    if (command === undefined) {
      throw new Error("Windows evidence opener is missing");
    }
    expect(command("frames\\first.txt")).toEqual({
      arguments: ["url.dll,FileProtocolHandler", "C:\\work\\quest\\frames\\first.txt"],
      executable: "D:\\Windows\\System32\\rundll32.exe",
    });
    expect(() => command("  ")).toThrow("evidence path must not be empty");
  });
});

describe("browser opener", () => {
  test("uses the native macOS opener without resolving the URL as a path", async () => {
    const commands: PlatformCommand[] = [];
    const platform = createPlatform({
      platform: "darwin",
      homeDirectory: posixHome,
      environment: {},
      workingDirectory: "/work/quest",
      runCommand: (command) => {
        commands.push(command);
        return Promise.resolve();
      },
    });
    const url = "https://github.com/janiorvalle/quest/pull/52";

    expect(platform.urlOpenCommand(url)).toEqual({
      arguments: [url],
      executable: "open",
    });
    await platform.openUrl(url);
    expect(commands).toEqual([{ arguments: [url], executable: "open" }]);
  });

  test("uses the Windows URL opener and rejects non-web schemes", () => {
    const platform = createPlatform({
      platform: "win32",
      homeDirectory: windowsHome,
      environment: { SystemRoot: "D:\\Windows" },
    });
    const url = "https://github.com/janiorvalle/quest/pull/52";

    expect(platform.urlOpenCommand(url)).toEqual({
      arguments: ["url.dll,FileProtocolHandler", url],
      executable: "D:\\Windows\\System32\\rundll32.exe",
    });
    expect(() => platform.urlOpenCommand("javascript:alert(1)")).toThrow(
      "URL must use the http or https scheme",
    );
  });
});

describe("scheduler entry points", () => {
  test("names the default Windows task per user", async () => {
    const statusFor = (username: string) =>
      createPlatform({
        platform: "win32",
        homeDirectory: windowsHome,
        environment: {
          COMPUTERNAME: "EXAMPLE-PC",
          USERDOMAIN: "WORKGROUP",
          USERNAME: username,
        },
        runCommandAndWait: (command) => Promise.resolve(windowsSchedulerResult(command, false)),
      }).scheduler.status();

    const first = await statusFor("FirstUser");
    const sameUser = await statusFor("FIRSTUSER");
    const second = await statusFor("SecondUser");

    expect(first.task_name).toMatch(/^Quest Backup - [0-9a-f]{16}$/);
    expect(sameUser.task_name).toBe(first.task_name);
    expect(second.task_name).not.toBe(first.task_name);
  });

  test.skipIf(process.platform === "win32")(
    "installs, inspects, and removes an isolated launchd agent",
    async () => {
      const homeDirectory = await mkdtemp(join(tmpdir(), "quest-launchd-scheduler-"));
      const executable = join(homeDirectory, "bin", "quest");
      const name = `com.janiorvalle.quest.test.${crypto.randomUUID()}`;
      const commands: PlatformCommand[] = [];
      let installed = false;
      const runCommand: PlatformCommandResultRunner = (command) => {
        commands.push(command);
        if (command.arguments[0] === "bootstrap") {
          installed = true;
        } else if (command.arguments[0] === "bootout") {
          installed = false;
        }
        return Promise.resolve({
          exitCode: command.arguments[0] === "print" && !installed ? 113 : 0,
          stderr: command.arguments[0] === "print" && !installed ? "Could not find service" : "",
          stdout: "",
        });
      };
      try {
        await mkdir(join(homeDirectory, "bin"), { recursive: true });
        await writeFile(executable, "binary", { mode: 0o700 });
        const platform = createPlatform({
          platform: "darwin",
          homeDirectory,
          environment: {},
          runCommandAndWait: runCommand,
          schedulerExecutable: executable,
          schedulerName: name,
          userId: "501",
        });
        const installedStatus = await platform.scheduler.install();
        expect(installedStatus).toEqual({
          definition_exists: true,
          definition_path: join(homeDirectory, "Library", "LaunchAgents", `${name}.plist`),
          executable,
          executable_exists: true,
          frequency: "daily",
          installed: true,
          kind: "launchd",
          task_name: null,
        });
        const definitionPath = installedStatus.definition_path;
        if (definitionPath === null) {
          throw new Error("launchd definition path is missing");
        }
        const definition = await readFile(definitionPath, "utf8");
        expect(definition).toContain(`<string>${name}</string>`);
        expect(definition).toContain(`<string>${executable}</string>`);
        expect(definition).toContain("<string>backup</string>");
        expect(definition).toContain("<string>run</string>");
        expect(definition).toContain("<integer>3</integer>");
        expect((await platform.scheduler.status()).installed).toBe(true);

        const removed = await platform.scheduler.remove();
        expect(removed.installed).toBe(false);
        expect(removed.definition_exists).toBe(false);
        await expect(stat(definitionPath)).rejects.toThrow();
        expect(commands.some((command) => command.arguments[0] === "bootstrap")).toBe(true);
        expect(commands.some((command) => command.arguments[0] === "bootout")).toBe(true);
      } finally {
        await rm(homeDirectory, { force: true, recursive: true });
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "installs, inspects, and removes isolated systemd user units",
    async () => {
      const homeDirectory = await mkdtemp(join(tmpdir(), "quest-systemd-scheduler-"));
      const executable = join(homeDirectory, "bin", "quest-$HOME-%n");
      const name = `quest-backup-test-${crypto.randomUUID()}`;
      const commands: PlatformCommand[] = [];
      let installed = false;
      const runCommand: PlatformCommandResultRunner = (command) => {
        commands.push(command);
        switch (command.arguments[1]) {
          case "enable":
            installed = true;
            return Promise.resolve({ exitCode: 0, stderr: "", stdout: "" });
          case "disable":
            installed = false;
            return Promise.resolve({ exitCode: 0, stderr: "", stdout: "" });
          case "is-enabled":
            return Promise.resolve(
              installed
                ? { exitCode: 0, stderr: "", stdout: "enabled\n" }
                : { exitCode: 4, stderr: "", stdout: "not-found\n" },
            );
          case "is-active":
            return Promise.resolve({ exitCode: 0, stderr: "", stdout: "active\n" });
          default:
            return Promise.resolve({ exitCode: 0, stderr: "", stdout: "" });
        }
      };
      try {
        await mkdir(join(homeDirectory, "bin"), { recursive: true });
        await writeFile(executable, "binary", { mode: 0o700 });
        const platform = createPlatform({
          platform: "linux",
          homeDirectory,
          environment: {},
          runCommandAndWait: runCommand,
          schedulerExecutable: executable,
          schedulerName: name,
        });

        const installedStatus = await platform.scheduler.install();
        expect(installedStatus.installed).toBe(true);
        expect(installedStatus.kind).toBe("systemd");
        expect(installedStatus.definition_path).toBe(
          join(homeDirectory, ".config", "systemd", "user", `${name}.timer`),
        );
        if (installedStatus.definition_path === null) {
          throw new Error("systemd timer path is missing");
        }
        const timer = await readFile(installedStatus.definition_path, "utf8");
        const service = await readFile(
          join(homeDirectory, ".config", "systemd", "user", `${name}.service`),
          "utf8",
        );
        expect(timer).toContain("OnCalendar=*-*-* 03:00:00");
        expect(timer).toContain(`Unit=${name}.service`);
        expect(service).toContain(
          `ExecStart="${executable.replaceAll("%", "%%").replaceAll("$", "$$")}" backup run`,
        );
        expect((await platform.scheduler.status()).installed).toBe(true);

        const removed = await platform.scheduler.remove();
        expect(removed.installed).toBe(false);
        expect(removed.definition_exists).toBe(false);
        expect(commands.some((command) => command.arguments.includes("enable"))).toBe(true);
        expect(commands.some((command) => command.arguments.includes("disable"))).toBe(true);
      } finally {
        await rm(homeDirectory, { force: true, recursive: true });
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "restores a working launchd schedule when refresh registration fails",
    async () => {
      const homeDirectory = await mkdtemp(join(tmpdir(), "quest-launchd-refresh-"));
      const executable = join(homeDirectory, "bin", "quest");
      const name = `com.janiorvalle.quest.refresh.${crypto.randomUUID()}`;
      const definitionPath = join(homeDirectory, "Library", "LaunchAgents", `${name}.plist`);
      const previousDefinition = "previous launchd definition\n";
      let bootstrapAttempts = 0;
      let registered = true;
      try {
        await mkdir(join(homeDirectory, "bin"), { recursive: true });
        await mkdir(join(homeDirectory, "Library", "LaunchAgents"), { recursive: true });
        await writeFile(executable, "binary", { mode: 0o700 });
        await writeFile(definitionPath, previousDefinition);
        const platform = createPlatform({
          platform: "darwin",
          homeDirectory,
          environment: {},
          runCommandAndWait: (command) => {
            switch (command.arguments[0]) {
              case "print":
                return Promise.resolve({
                  exitCode: registered ? 0 : 113,
                  stderr: registered ? "" : "Could not find service",
                  stdout: "",
                });
              case "bootout":
                registered = false;
                return Promise.resolve({ exitCode: 0, stderr: "", stdout: "" });
              case "bootstrap":
                bootstrapAttempts += 1;
                if (bootstrapAttempts > 1) {
                  registered = true;
                  return Promise.resolve({ exitCode: 0, stderr: "", stdout: "" });
                }
                return Promise.resolve({ exitCode: 1, stderr: "replacement rejected", stdout: "" });
              case "load":
                return Promise.resolve({ exitCode: 1, stderr: "replacement rejected", stdout: "" });
              default:
                throw new Error(`unexpected launchctl operation: ${command.arguments[0]}`);
            }
          },
          schedulerExecutable: executable,
          schedulerName: name,
          userId: "501",
        });

        await expect(platform.scheduler.install()).rejects.toThrow(
          "launchctl load failed: replacement rejected",
        );

        expect(await readFile(definitionPath, "utf8")).toBe(previousDefinition);
        expect((await platform.scheduler.status()).installed).toBe(true);
        expect(bootstrapAttempts).toBe(2);
      } finally {
        await rm(homeDirectory, { force: true, recursive: true });
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "restores a working systemd schedule when refresh registration fails",
    async () => {
      const homeDirectory = await mkdtemp(join(tmpdir(), "quest-systemd-refresh-"));
      const executable = join(homeDirectory, "bin", "quest");
      const name = `quest-backup-refresh-${crypto.randomUUID()}`;
      const unitDirectory = join(homeDirectory, ".config", "systemd", "user");
      const timerPath = join(unitDirectory, `${name}.timer`);
      const servicePath = join(unitDirectory, `${name}.service`);
      const previousTimer = "previous systemd timer\n";
      const previousService = "previous systemd service\n";
      let enableAttempts = 0;
      let reloadAttempts = 0;
      try {
        await mkdir(join(homeDirectory, "bin"), { recursive: true });
        await mkdir(unitDirectory, { recursive: true });
        await writeFile(executable, "binary", { mode: 0o700 });
        await writeFile(timerPath, previousTimer);
        await writeFile(servicePath, previousService);
        const platform = createPlatform({
          platform: "linux",
          homeDirectory,
          environment: {},
          runCommandAndWait: (command) => {
            switch (command.arguments[1]) {
              case "is-enabled":
                return Promise.resolve({ exitCode: 0, stderr: "", stdout: "enabled\n" });
              case "is-active":
                return Promise.resolve({ exitCode: 0, stderr: "", stdout: "active\n" });
              case "daemon-reload":
                reloadAttempts += 1;
                return Promise.resolve({ exitCode: 0, stderr: "", stdout: "" });
              case "enable":
                enableAttempts += 1;
                return Promise.resolve(
                  enableAttempts === 1
                    ? { exitCode: 1, stderr: "replacement rejected", stdout: "" }
                    : { exitCode: 0, stderr: "", stdout: "" },
                );
              default:
                throw new Error(`unexpected systemctl operation: ${command.arguments[1]}`);
            }
          },
          schedulerExecutable: executable,
          schedulerName: name,
        });

        await expect(platform.scheduler.install()).rejects.toThrow(
          "systemctl enable failed: replacement rejected",
        );

        expect(await readFile(timerPath, "utf8")).toBe(previousTimer);
        expect(await readFile(servicePath, "utf8")).toBe(previousService);
        expect(enableAttempts).toBe(2);
        expect(reloadAttempts).toBe(2);
      } finally {
        await rm(homeDirectory, { force: true, recursive: true });
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "reports an enabled but stopped systemd timer as not installed",
    async () => {
      const homeDirectory = await mkdtemp(join(tmpdir(), "quest-stopped-systemd-scheduler-"));
      const name = `quest-backup-stopped-${crypto.randomUUID()}`;
      const unitDirectory = join(homeDirectory, ".config", "systemd", "user");
      try {
        await mkdir(unitDirectory, { recursive: true });
        await writeFile(join(unitDirectory, `${name}.timer`), "stopped timer");
        await writeFile(join(unitDirectory, `${name}.service`), "stopped service");
        const platform = createPlatform({
          platform: "linux",
          homeDirectory,
          environment: {},
          runCommandAndWait: (command) =>
            Promise.resolve(
              command.arguments.includes("is-active")
                ? { exitCode: 3, stderr: "", stdout: "inactive\n" }
                : { exitCode: 0, stderr: "", stdout: "enabled\n" },
            ),
          schedulerExecutable: join(homeDirectory, "bin", "quest"),
          schedulerName: name,
        });

        const status = await platform.scheduler.status();

        expect(status.installed).toBe(false);
        expect(status.definition_exists).toBe(true);
      } finally {
        await rm(homeDirectory, { force: true, recursive: true });
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "requires both systemd unit definitions for installed status",
    async () => {
      const homeDirectory = await mkdtemp(join(tmpdir(), "quest-incomplete-systemd-scheduler-"));
      const name = `quest-backup-incomplete-${crypto.randomUUID()}`;
      const unitDirectory = join(homeDirectory, ".config", "systemd", "user");
      try {
        await mkdir(unitDirectory, { recursive: true });
        await writeFile(join(unitDirectory, `${name}.timer`), "incomplete timer");
        const platform = createPlatform({
          platform: "linux",
          homeDirectory,
          environment: {},
          runCommandAndWait: (command) =>
            Promise.resolve({
              exitCode: 0,
              stderr: "",
              stdout: command.arguments.includes("is-active") ? "active\n" : "enabled\n",
            }),
          schedulerExecutable: join(homeDirectory, "bin", "quest"),
          schedulerName: name,
        });

        const status = await platform.scheduler.status();

        expect(status.installed).toBe(false);
        expect(status.definition_exists).toBe(false);
      } finally {
        await rm(homeDirectory, { force: true, recursive: true });
      }
    },
  );

  test("installs, inspects, and removes an isolated Windows scheduled task", async () => {
    const name = `Quest Backup Test ${crypto.randomUUID()}`;
    const executable =
      process.platform === "win32"
        ? "C:\\Windows\\System32\\where.exe"
        : `C:\\Quest Test\\quest-${crypto.randomUUID()}.exe`;
    const removeExecutable = process.platform !== "win32";
    const commands: PlatformCommand[] = [];
    let installed = false;
    const runCommand: PlatformCommandResultRunner = (command) => {
      commands.push(command);
      if (command.arguments[0] === "/Create") {
        installed = true;
      } else if (command.arguments[0] === "/Delete") {
        installed = false;
      }
      return Promise.resolve(windowsSchedulerResult(command, installed));
    };
    try {
      if (removeExecutable) {
        await writeFile(executable, "binary");
      }
      const platform = createPlatform({
        platform: "win32",
        homeDirectory: windowsHome,
        environment: {
          APPDATA: "C:\\Users\\Example\\AppData\\Roaming",
          COMPUTERNAME: "EXAMPLE-PC",
          LOCALAPPDATA: "C:\\Users\\Example\\AppData\\Local",
          USERDOMAIN: "WORKGROUP",
          USERNAME: "User",
        },
        runCommandAndWait: runCommand,
        schedulerExecutable: executable,
        schedulerName: name,
      });

      const installedStatus = await platform.scheduler.install();
      expect(installedStatus).toEqual({
        definition_exists: true,
        definition_path: "C:\\Users\\Example\\AppData\\Roaming\\quest\\backup-schedule.xml",
        executable,
        executable_exists: true,
        frequency: "daily",
        installed: true,
        kind: "schtasks",
        task_name: name,
      });
      const create = commands.find((command) => command.arguments[0] === "/Create");
      expect(create?.executable).toBe("C:\\Windows\\System32\\schtasks.exe");
      expect(create?.arguments).toEqual([
        "/Create",
        "/TN",
        name,
        "/XML",
        "C:\\Users\\Example\\AppData\\Roaming\\quest\\backup-schedule.xml",
        "/F",
      ]);
      if (installedStatus.definition_path === null) {
        throw new Error("Windows task definition path is missing");
      }
      const definitionBytes = await readFile(installedStatus.definition_path);
      expect([...definitionBytes.subarray(0, 2)]).toEqual([0xff, 0xfe]);
      const definition = new TextDecoder("utf-16le").decode(definitionBytes);
      expect(definition).toContain('encoding="UTF-16"');
      expect(definition).toContain("<DaysInterval>1</DaysInterval>");
      expect(definition).toContain(`<Command>${executable}</Command>`);
      expect(definition).toContain("<Arguments>backup run</Arguments>");
      expect(definition).toContain("<UserId>EXAMPLE-PC\\User</UserId>");
      expect((await platform.scheduler.status()).installed).toBe(true);
      expect((await platform.scheduler.remove()).installed).toBe(false);
      expect(commands.some((command) => command.arguments[0] === "/Delete")).toBe(true);
      expect(
        commands.some(
          (command) =>
            command.executable === "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        ),
      ).toBe(true);
    } finally {
      if (removeExecutable) {
        await rm(executable, { force: true });
      }
    }
  });

  test("propagates operational scheduler status failures", async () => {
    const cases: readonly {
      readonly executable: string;
      readonly homeDirectory: string;
      readonly platform: SupportedPlatform;
      readonly statusError: string;
    }[] = [
      {
        executable: "/usr/bin/quest",
        homeDirectory: "/Users/example",
        platform: "darwin",
        statusError: "launchctl status failed: access denied",
      },
      {
        executable: "/usr/bin/quest",
        homeDirectory: "/home/example",
        platform: "linux",
        statusError: "systemctl status failed: access denied",
      },
      {
        executable: "C:\\Quest\\quest.exe",
        homeDirectory: windowsHome,
        platform: "win32",
        statusError: "powershell.exe status probe failed: access denied",
      },
    ];

    for (const schedulerCase of cases) {
      const platform = createPlatform({
        platform: schedulerCase.platform,
        homeDirectory: schedulerCase.homeDirectory,
        environment: {},
        runCommandAndWait: () =>
          Promise.resolve({
            exitCode: 1,
            stderr: "access denied",
            stdout: "",
          }),
        schedulerExecutable: schedulerCase.executable,
        schedulerName: `quest-status-failure-${schedulerCase.platform}`,
        userId: "501",
      });

      await expect(platform.scheduler.status()).rejects.toThrow(schedulerCase.statusError);
    }
  });

  test("reports an existing but disabled Windows task as not installed", async () => {
    const commands: PlatformCommand[] = [];
    let registered = true;
    const platform = createPlatform({
      platform: "win32",
      homeDirectory: windowsHome,
      environment: {},
      runCommandAndWait: (command) => {
        commands.push(command);
        if (command.arguments[0] === "/Delete") {
          registered = false;
        }
        return Promise.resolve(windowsSchedulerResult(command, registered, false));
      },
      schedulerExecutable: "C:\\Quest\\quest.exe",
      schedulerName: "Quest Disabled Backup",
      userId: "EXAMPLE-PC\\User",
    });

    const status = await platform.scheduler.status();

    expect(status.installed).toBe(false);
    expect(status.kind).toBe("schtasks");
    expect((await platform.scheduler.remove()).installed).toBe(false);
    expect(commands.some((command) => command.arguments[0] === "/Delete")).toBe(true);
  });

  test.skipIf(process.platform === "win32")(
    "refuses to install a schedule for a missing executable",
    async () => {
      const homeDirectory = await mkdtemp(join(tmpdir(), "quest-missing-scheduler-"));
      const executable = join(homeDirectory, "bin", "missing-quest");
      const commands: PlatformCommand[] = [];
      try {
        const platform = createPlatform({
          platform: "linux",
          homeDirectory,
          environment: {},
          runCommandAndWait: (command) => {
            commands.push(command);
            return Promise.resolve({ exitCode: 0, stderr: "", stdout: "" });
          },
          schedulerExecutable: executable,
          schedulerName: `quest-backup-missing-${crypto.randomUUID()}`,
        });

        await expect(platform.scheduler.install()).rejects.toThrow(
          `scheduler executable does not exist: ${executable}`,
        );
        await mkdir(executable, { recursive: true });
        await expect(platform.scheduler.install()).rejects.toThrow(
          `scheduler executable is not a regular file: ${executable}`,
        );
        await rm(executable, { force: true, recursive: true });
        await mkdir(join(homeDirectory, "bin"), { recursive: true });
        await writeFile(executable, "binary", { mode: 0o600 });
        await expect(platform.scheduler.install()).rejects.toThrow(
          `scheduler executable is not executable: ${executable}`,
        );
        expect(commands).toEqual([]);
        expect(
          await readdir(join(homeDirectory, ".config"), { recursive: true }).catch(() => []),
        ).toEqual([]);
      } finally {
        await rm(homeDirectory, { force: true, recursive: true });
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "removes a partial systemd schedule with only a service definition",
    async () => {
      const homeDirectory = await mkdtemp(join(tmpdir(), "quest-partial-systemd-scheduler-"));
      const name = `quest-backup-partial-${crypto.randomUUID()}`;
      const unitDirectory = join(homeDirectory, ".config", "systemd", "user");
      const servicePath = join(unitDirectory, `${name}.service`);
      const commands: PlatformCommand[] = [];
      try {
        await mkdir(unitDirectory, { recursive: true });
        await writeFile(servicePath, "partial service");
        const platform = createPlatform({
          platform: "linux",
          homeDirectory,
          environment: {},
          runCommandAndWait: (command) => {
            commands.push(command);
            return Promise.resolve({
              exitCode: command.arguments.includes("is-enabled") ? 4 : 0,
              stderr: "",
              stdout: command.arguments.includes("is-enabled") ? "not-found\n" : "",
            });
          },
          schedulerExecutable: join(homeDirectory, "bin", "quest"),
          schedulerName: name,
        });

        const removed = await platform.scheduler.remove();

        expect(removed.installed).toBe(false);
        expect(removed.definition_exists).toBe(false);
        await expect(stat(servicePath)).rejects.toThrow();
        expect(commands.some((command) => command.arguments.includes("disable"))).toBe(false);
        expect(commands.some((command) => command.arguments.includes("daemon-reload"))).toBe(true);
      } finally {
        await rm(homeDirectory, { force: true, recursive: true });
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "inspects and removes a masked systemd timer",
    async () => {
      const homeDirectory = await mkdtemp(join(tmpdir(), "quest-masked-systemd-scheduler-"));
      const name = `quest-backup-masked-${crypto.randomUUID()}`;
      const unitDirectory = join(homeDirectory, ".config", "systemd", "user");
      const timerPath = join(unitDirectory, `${name}.timer`);
      const servicePath = join(unitDirectory, `${name}.service`);
      const commands: PlatformCommand[] = [];
      let registered = true;
      try {
        await mkdir(unitDirectory, { recursive: true });
        await writeFile(timerPath, "masked timer");
        await writeFile(servicePath, "masked service");
        const platform = createPlatform({
          platform: "linux",
          homeDirectory,
          environment: {},
          runCommandAndWait: (command) => {
            commands.push(command);
            switch (command.arguments[1]) {
              case "unmask":
                return Promise.resolve({ exitCode: 0, stderr: "", stdout: "" });
              case "disable":
                registered = false;
                return Promise.resolve({ exitCode: 0, stderr: "", stdout: "" });
              case "is-enabled":
                return Promise.resolve(
                  registered
                    ? { exitCode: 1, stderr: "", stdout: "masked\n" }
                    : { exitCode: 4, stderr: "", stdout: "not-found\n" },
                );
              default:
                return Promise.resolve({ exitCode: 0, stderr: "", stdout: "" });
            }
          },
          schedulerExecutable: join(homeDirectory, "bin", "quest"),
          schedulerName: name,
        });

        expect((await platform.scheduler.status()).installed).toBe(false);
        const removed = await platform.scheduler.remove();

        expect(removed.installed).toBe(false);
        expect(removed.definition_exists).toBe(false);
        await expect(stat(timerPath)).rejects.toThrow();
        await expect(stat(servicePath)).rejects.toThrow();
        expect(commands.some((command) => command.arguments.includes("unmask"))).toBe(true);
        expect(commands.some((command) => command.arguments.includes("disable"))).toBe(true);
      } finally {
        await rm(homeDirectory, { force: true, recursive: true });
      }
    },
  );
});

describe("PATH install helper", () => {
  test("reads PATH and prepends the POSIX install directory once", () => {
    const platform = createPlatform({
      platform: "linux",
      homeDirectory: "/home/example",
      environment: { PATH: "/usr/local/bin:/usr/bin" },
    });

    expect(platform.isInstallDirectoryOnPath()).toBe(false);
    expect(platform.addInstallDirectoryToPath()).toBe(
      "/home/example/.local/bin:/usr/local/bin:/usr/bin",
    );
    expect(platform.addInstallDirectoryToPath("/home/example/.local/bin:/usr/bin")).toBe(
      "/home/example/.local/bin:/usr/bin",
    );
    expect(platform.isInstallDirectoryOnPath("/usr/bin:/home/example/.local/bin/")).toBe(true);
    expect(platform.addInstallDirectoryToPath("/usr/bin:/home/example/.local/bin/")).toBe(
      "/usr/bin:/home/example/.local/bin/",
    );
  });

  test("does not treat a lowercase POSIX path variable as PATH", () => {
    const platform = createPlatform({
      platform: "linux",
      homeDirectory: "/home/example",
      environment: {
        path: "/home/example/.local/bin",
        PATH: "/usr/bin",
      },
    });

    expect(platform.isInstallDirectoryOnPath()).toBe(false);
    expect(platform.addInstallDirectoryToPath()).toBe("/home/example/.local/bin:/usr/bin");
  });

  test("uses case-insensitive quoted Windows PATH comparison", () => {
    const platform = createPlatform({
      platform: "win32",
      homeDirectory: windowsHome,
      environment: {
        LOCALAPPDATA: "C:\\Users\\Example\\AppData\\Local",
        Path: '"c:\\users\\example\\appdata\\local\\programs\\quest";C:\\Windows',
      },
    });

    expect(platform.isInstallDirectoryOnPath()).toBe(true);
    expect(platform.addInstallDirectoryToPath()).toBe(
      '"c:\\users\\example\\appdata\\local\\programs\\quest";C:\\Windows',
    );
    expect(
      platform.isInstallDirectoryOnPath(
        '"c:\\users\\example\\appdata\\local\\programs\\quest\\";C:\\Windows',
      ),
    ).toBe(true);
  });

  test("uses conservative macOS path comparison and handles an empty PATH", () => {
    const platform = createPlatform({
      platform: "darwin",
      homeDirectory: posixHome,
      environment: {},
    });

    expect(platform.isInstallDirectoryOnPath("/USERS/EXAMPLE/.LOCAL/BIN:/usr/bin")).toBe(false);
    expect(platform.isInstallDirectoryOnPath("/Users/example/.local/bin/:/usr/bin")).toBe(true);
    expect(platform.addInstallDirectoryToPath("/USERS/EXAMPLE/.LOCAL/BIN:/usr/bin")).toBe(
      "/Users/example/.local/bin:/USERS/EXAMPLE/.LOCAL/BIN:/usr/bin",
    );
    expect(platform.isInstallDirectoryOnPath("")).toBe(false);
    expect(platform.addInstallDirectoryToPath("")).toBe("/Users/example/.local/bin");
  });
});
