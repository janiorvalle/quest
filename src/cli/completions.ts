import type { Argument, Command, Option } from "commander";
import { Argument as CommanderArgument } from "commander";
import { z } from "zod";

const ROOT_COMMAND_KEY = "__root__";

export const completionShellSchema = z.enum(["zsh", "bash", "fish"]);
export type CompletionShell = z.infer<typeof completionShellSchema>;

export interface CompletionCliRequest {
  readonly command: "completions";
  readonly shell: CompletionShell;
}

export interface CompletionRequestCapture {
  set(request: CompletionCliRequest): void;
}

type CompletionParameter = Argument | Option;

const supplementalCompletionChoices = new WeakMap<CompletionParameter, readonly string[]>();

export function withCompletionChoices<T extends CompletionParameter>(
  parameter: T,
  choices: readonly string[],
): T {
  supplementalCompletionChoices.set(parameter, [...choices]);
  return parameter;
}

export function registerCompletionCommand(
  program: Command,
  capture: CompletionRequestCapture,
): void {
  const command = program
    .command("completions")
    .description("emit shell completion scripts")
    .addArgument(new CommanderArgument("<shell>").choices(completionShellSchema.options));
  command.action((shell: string) => {
    capture.set({
      command: "completions",
      shell: completionShellSchema.parse(shell),
    });
  });
}

type OptionValueMode = "none" | "required" | "optional";
type OptionArity = OptionValueMode | "required-variadic" | "optional-variadic";

interface CompletionOption {
  readonly choices: readonly string[];
  readonly filePath: boolean;
  readonly flags: readonly string[];
  readonly variadic: boolean;
  readonly valueMode: OptionValueMode;
}

interface CompletionArgument {
  readonly choices: readonly string[];
  readonly filePath: boolean;
}

interface CompletionChild {
  readonly key: string;
  readonly name: string;
}

interface CompletionCommand {
  readonly arguments: readonly CompletionArgument[];
  readonly children: readonly CompletionChild[];
  readonly key: string;
  readonly options: readonly CompletionOption[];
}

interface CompletionModel {
  readonly commands: readonly CompletionCommand[];
}

interface LookupEntry {
  readonly key: string;
  readonly values: readonly string[];
}

function completionChoices(parameter: CompletionParameter): readonly string[] {
  return supplementalCompletionChoices.get(parameter) ?? parameter.argChoices ?? [];
}

function parameterName(value: string): string | undefined {
  const match = /[<[]([^>\]]+)[>\]]/u.exec(value);
  return match?.[1]?.replace(/\.\.\.$/u, "");
}

function isFilePathParameter(value: string | undefined): boolean {
  return value === "dir" || value === "directory" || value === "file" || value === "path";
}

function commandKey(path: readonly string[]): string {
  return path.length === 0 ? ROOT_COMMAND_KEY : path.join(" ");
}

function collectOptions(command: Command): readonly CompletionOption[] {
  const ancestors: Command[] = [];
  for (let current: Command | null = command; current !== null; current = current.parent) {
    ancestors.unshift(current);
  }

  const options: CompletionOption[] = [];
  const seenFlags = new Set<string>();
  for (const ancestor of ancestors) {
    for (const option of ancestor.createHelp().visibleOptions(ancestor)) {
      const flags = [option.short, option.long].filter(
        (flag): flag is string => flag !== undefined,
      );
      const identity = flags.join("\u0000");
      if (flags.length === 0 || seenFlags.has(identity)) {
        continue;
      }
      seenFlags.add(identity);
      options.push({
        choices: completionChoices(option),
        filePath: isFilePathParameter(parameterName(option.flags)),
        flags,
        valueMode: option.required ? "required" : option.optional ? "optional" : "none",
        variadic: option.variadic,
      });
    }
  }
  return options;
}

function collectCommand(
  command: Command,
  path: readonly string[],
  commands: CompletionCommand[],
): void {
  const key = commandKey(path);
  const children = command.commands.map((child) => {
    const name = child.name();
    return { key: commandKey([...path, name]), name };
  });
  commands.push({
    arguments: command.registeredArguments.map((argument) => ({
      choices: completionChoices(argument),
      filePath: isFilePathParameter(argument.name()),
    })),
    children,
    key,
    options: collectOptions(command),
  });
  for (const child of command.commands) {
    collectCommand(child, [...path, child.name()], commands);
  }
}

function buildCompletionModel(program: Command): CompletionModel {
  const commands: CompletionCommand[] = [];
  collectCommand(program, [], commands);
  return { commands };
}

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function listLookupEntries(
  model: CompletionModel,
  getValues: (command: CompletionCommand) => readonly string[],
): readonly LookupEntry[] {
  return model.commands.flatMap((command) => {
    const values = getValues(command);
    return values.length === 0 ? [] : [{ key: command.key, values }];
  });
}

function optionArityEntries(model: CompletionModel): readonly LookupEntry[] {
  return model.commands.flatMap((command) =>
    command.options.flatMap((option) =>
      option.flags.map((flag) => ({
        key: `${command.key}|${flag}`,
        values: [optionArity(option)],
      })),
    ),
  );
}

function optionArity(option: CompletionOption): OptionArity {
  if (!option.variadic || option.valueMode === "none") {
    return option.valueMode;
  }
  return option.valueMode === "required" ? "required-variadic" : "optional-variadic";
}

function optionValueEntries(model: CompletionModel): readonly LookupEntry[] {
  return model.commands.flatMap((command) =>
    command.options.flatMap((option) =>
      option.choices.length === 0
        ? []
        : option.flags.map((flag) => ({
            key: `${command.key}|${flag}`,
            values: option.choices,
          })),
    ),
  );
}

function optionFilePathEntries(model: CompletionModel): readonly LookupEntry[] {
  return model.commands.flatMap((command) =>
    command.options.flatMap((option) =>
      option.filePath
        ? option.flags.map((flag) => ({
            key: `${command.key}|${flag}`,
            values: ["yes"],
          }))
        : [],
    ),
  );
}

function argumentValueEntries(model: CompletionModel): readonly LookupEntry[] {
  return model.commands.flatMap((command) =>
    command.arguments.flatMap((argument, index) =>
      argument.choices.length === 0
        ? []
        : [{ key: `${command.key}|${index}`, values: argument.choices }],
    ),
  );
}

function argumentFilePathEntries(model: CompletionModel): readonly LookupEntry[] {
  return model.commands.flatMap((command) =>
    command.arguments.flatMap((argument, index) =>
      argument.filePath ? [{ key: `${command.key}|${index}`, values: ["yes"] }] : [],
    ),
  );
}

function filePathOptionEntries(model: CompletionModel): readonly LookupEntry[] {
  const flags = [
    ...new Set(
      model.commands.flatMap((command) =>
        command.options.flatMap((option) => (option.filePath ? option.flags : [])),
      ),
    ),
  ];
  return flags.length === 0 ? [] : [{ key: ROOT_COMMAND_KEY, values: flags }];
}

function attachedOptionEntries(model: CompletionModel): readonly LookupEntry[] {
  return listLookupEntries(model, (command) =>
    command.options.flatMap((option) =>
      option.valueMode === "none"
        ? []
        : option.flags.filter((flag) => flag.startsWith("-") && !flag.startsWith("--")),
    ),
  );
}

function childPathEntries(model: CompletionModel): readonly LookupEntry[] {
  return model.commands.flatMap((command) =>
    command.children.map((child) => ({
      key: `${command.key}|${child.name}`,
      values: [child.key],
    })),
  );
}

function renderBashLookup(name: string, entries: readonly LookupEntry[]): string[] {
  return [
    `${name}() {`,
    '  case "$1" in',
    ...entries.flatMap((entry) => [
      `    ${quoteShell(entry.key)})`,
      `      printf '%s\\n' ${entry.values.map(quoteShell).join(" ")};`,
      "      ;;",
    ]),
    "  esac",
    "  return 1",
    "}",
    "",
  ];
}

function renderBashCompletion(model: CompletionModel): string {
  const lines = ["# bash completion for quest. Generated from the Commander command tree.", ""];
  lines.push(
    ...renderBashLookup(
      "_quest_children",
      listLookupEntries(model, (command) => command.children.map((child) => child.name)),
    ),
    ...renderBashLookup(
      "_quest_options",
      listLookupEntries(model, (command) => command.options.flatMap((option) => option.flags)),
    ),
    ...renderBashLookup("_quest_option_arity", optionArityEntries(model)),
    ...renderBashLookup("_quest_option_values", optionValueEntries(model)),
    ...renderBashLookup("_quest_option_file_paths", optionFilePathEntries(model)),
    ...renderBashLookup("_quest_argument_values", argumentValueEntries(model)),
    ...renderBashLookup("_quest_argument_file_paths", argumentFilePathEntries(model)),
    ...renderBashLookup("_quest_attached_options", attachedOptionEntries(model)),
    ...renderBashLookup("_quest_child_path", childPathEntries(model)),
    "_quest_enable_filenames() {",
    "  if command -v compopt >/dev/null 2>&1; then",
    "    compopt -o filenames",
    "  fi",
    "}",
    "",
    "_quest_complete() {",
    `  local current="\${COMP_WORDS[COMP_CWORD]-}"`,
    `  local command_path=${quoteShell(ROOT_COMMAND_KEY)}`,
    "  local index=1",
    "  local argument_index=0",
    "  local token arity child_path previous pending_option value_option choices option value candidate",
    "  COMPREPLY=()",
    "",
    "  while (( index < COMP_CWORD )); do",
    `    token="\${COMP_WORDS[index]}"`,
    '    if [[ "$token" == -* ]]; then',
    '      pending_option=""',
    '      if [[ "$token" != *=* ]]; then',
    '        arity="$(_quest_option_arity "$command_path|$token")"',
    '        if [[ "$arity" == required || "$arity" == optional ]]; then',
    "          (( index += 2 ))",
    "          continue",
    "        fi",
    '        if [[ "$arity" == required-variadic || "$arity" == optional-variadic ]]; then',
    '          pending_option="$token"',
    "          (( index += 1 ))",
    "          while (( index < COMP_CWORD )); do",
    `            if [[ "\${COMP_WORDS[index]}" == -* ]]; then break; fi`,
    "            (( index += 1 ))",
    "          done",
    "          continue",
    "        fi",
    "      else",
    `        option="\${token%%=*}"`,
    '        arity="$(_quest_option_arity "$command_path|$option")"',
    '        if [[ "$arity" == required-variadic || "$arity" == optional-variadic ]]; then',
    '          pending_option="$option"',
    "          (( index += 1 ))",
    "          while (( index < COMP_CWORD )); do",
    `            if [[ "\${COMP_WORDS[index]}" == -* ]]; then break; fi`,
    "            (( index += 1 ))",
    "          done",
    "          continue",
    "        fi",
    "      fi",
    "      (( index += 1 ))",
    "      continue",
    "    fi",
    '    child_path="$(_quest_child_path "$command_path|$token")"',
    '    if [[ -n "$child_path" ]]; then',
    '      command_path="$child_path"',
    "      argument_index=0",
    "    else",
    "      (( argument_index += 1 ))",
    "    fi",
    "    (( index += 1 ))",
    "  done",
    "",
    `  if (( COMP_CWORD > 0 )); then previous="\${COMP_WORDS[COMP_CWORD - 1]}"; else previous=""; fi`,
    '  value_option="$previous"',
    '  if [[ -n "$pending_option" ]]; then value_option="$pending_option"; fi',
    '  arity="$(_quest_option_arity "$command_path|$value_option")"',
    '  if [[ "$current" != -* && "$previous" != *=* && ( "$arity" == required || "$arity" == optional || "$arity" == required-variadic || "$arity" == optional-variadic ) ]]; then',
    '    choices="$(_quest_option_values "$command_path|$value_option")"',
    '    if [[ -n "$choices" ]]; then',
    '      COMPREPLY=( $(compgen -W "$choices" -- "$current") )',
    "      return 0",
    "    fi",
    '    if [[ "$(_quest_option_file_paths "$command_path|$value_option")" == yes ]]; then',
    "      _quest_enable_filenames",
    "      COMPREPLY=()",
    "      while IFS= read -r candidate; do",
    `        COMPREPLY[\${#COMPREPLY[@]}]="$candidate"`,
    '      done < <(compgen -f -- "$current")',
    "    fi",
    "    return 0",
    "  fi",
    '  if [[ "$current" == -*=* ]]; then',
    `    option="\${current%%=*}"`,
    `    value="\${current#*=}"`,
    '    choices="$(_quest_option_values "$command_path|$option")"',
    '    if [[ -n "$choices" ]]; then',
    "      for candidate in $choices; do",
    '        if [[ "$candidate" == "$value"* ]]; then',
    `          COMPREPLY[\${#COMPREPLY[@]}]="$option=$candidate"`,
    "        fi",
    "      done",
    "      return 0",
    "    fi",
    '    if [[ "$(_quest_option_file_paths "$command_path|$option")" == yes ]]; then',
    "      _quest_enable_filenames",
    "      while IFS= read -r candidate; do",
    `        COMPREPLY[\${#COMPREPLY[@]}]="$option=$candidate"`,
    '      done < <(compgen -f -- "$value")',
    "    fi",
    "    return 0",
    "  fi",
    '  if [[ "$current" == -?* && "$current" != --* ]]; then',
    '    for option in $(_quest_attached_options "$command_path"); do',
    `      if [[ "$current" == "$option"* && "\${#current}" -gt "\${#option}" ]]; then`,
    `        value="\${current:\${#option}}"`,
    '        choices="$(_quest_option_values "$command_path|$option")"',
    '        if [[ -n "$choices" ]]; then',
    "          for candidate in $choices; do",
    '            if [[ "$candidate" == "$value"* ]]; then',
    `              COMPREPLY[\${#COMPREPLY[@]}]="$option$candidate"`,
    "            fi",
    "          done",
    "          return 0",
    "        fi",
    '        if [[ "$(_quest_option_file_paths "$command_path|$option")" == yes ]]; then',
    "          _quest_enable_filenames",
    "          while IFS= read -r candidate; do",
    `            COMPREPLY[\${#COMPREPLY[@]}]="$option$candidate"`,
    '          done < <(compgen -f -- "$value")',
    "        fi",
    "        return 0",
    "      fi",
    "    done",
    "  fi",
    '  if [[ "$current" == -* ]]; then',
    '    choices="$(_quest_options "$command_path")"',
    '    COMPREPLY=( $(compgen -W "$choices" -- "$current") )',
    "    return 0",
    "  fi",
    "  if (( argument_index == 0 )); then",
    '    choices="$(_quest_children "$command_path")"',
    '    if [[ -n "$choices" ]]; then',
    '      COMPREPLY=( $(compgen -W "$choices" -- "$current") )',
    "      return 0",
    "    fi",
    "  fi",
    '  choices="$(_quest_argument_values "$command_path|$argument_index")"',
    '  if [[ -n "$choices" ]]; then',
    '    COMPREPLY=( $(compgen -W "$choices" -- "$current") )',
    "    return 0",
    "  fi",
    '  if [[ "$(_quest_argument_file_paths "$command_path|$argument_index")" == yes ]]; then',
    "    _quest_enable_filenames",
    "    COMPREPLY=()",
    "    while IFS= read -r candidate; do",
    `      COMPREPLY[\${#COMPREPLY[@]}]="$candidate"`,
    '    done < <(compgen -f -- "$current")',
    "  fi",
    "}",
    "",
    "complete -F _quest_complete quest",
    "",
  );
  return lines.join("\n");
}

function renderZshLookup(name: string, entries: readonly LookupEntry[]): string[] {
  return [
    `${name}() {`,
    '  case "$1" in',
    ...entries.flatMap((entry) => [
      `    ${quoteShell(entry.key)})`,
      `      print -r -- ${entry.values.map(quoteShell).join(" ")};`,
      "      ;;",
    ]),
    "  esac",
    "  return 1",
    "}",
    "",
  ];
}

function renderZshCompletion(model: CompletionModel): string {
  const lines = [
    "#compdef quest",
    "# zsh completion for quest. Generated from the Commander command tree.",
    "",
    ...renderZshLookup(
      "_quest_children",
      listLookupEntries(model, (command) => command.children.map((child) => child.name)),
    ),
    ...renderZshLookup(
      "_quest_options",
      listLookupEntries(model, (command) => command.options.flatMap((option) => option.flags)),
    ),
    ...renderZshLookup("_quest_option_arity", optionArityEntries(model)),
    ...renderZshLookup("_quest_option_values", optionValueEntries(model)),
    ...renderZshLookup("_quest_option_file_paths", optionFilePathEntries(model)),
    ...renderZshLookup("_quest_argument_values", argumentValueEntries(model)),
    ...renderZshLookup("_quest_argument_file_paths", argumentFilePathEntries(model)),
    ...renderZshLookup("_quest_attached_options", attachedOptionEntries(model)),
    ...renderZshLookup("_quest_child_path", childPathEntries(model)),
    `  local current="\${words[CURRENT]-}"`,
    `  local command_path=${quoteShell(ROOT_COMMAND_KEY)}`,
    "  local index=2",
    "  local argument_index=0",
    "  local token arity child_path previous pending_option value_option choices option value candidate",
    "  local -a matches",
    "",
    "  while (( index < CURRENT )); do",
    `    token="\${words[index]}"`,
    '    if [[ "$token" == -* ]]; then',
    '      pending_option=""',
    '      if [[ "$token" != *=* ]]; then',
    '        arity="$(_quest_option_arity "$command_path|$token")"',
    '        if [[ "$arity" == required || "$arity" == optional ]]; then',
    "          (( index += 2 ))",
    "          continue",
    "        fi",
    '        if [[ "$arity" == required-variadic || "$arity" == optional-variadic ]]; then',
    '          pending_option="$token"',
    "          (( index += 1 ))",
    "          while (( index < CURRENT )); do",
    `            if [[ "\${words[index]}" == -* ]]; then break; fi`,
    "            (( index += 1 ))",
    "          done",
    "          continue",
    "        fi",
    "      else",
    `        option="\${token%%=*}"`,
    '        arity="$(_quest_option_arity "$command_path|$option")"',
    '        if [[ "$arity" == required-variadic || "$arity" == optional-variadic ]]; then',
    '          pending_option="$option"',
    "          (( index += 1 ))",
    "          while (( index < CURRENT )); do",
    `            if [[ "\${words[index]}" == -* ]]; then break; fi`,
    "            (( index += 1 ))",
    "          done",
    "          continue",
    "        fi",
    "      fi",
    "      (( index += 1 ))",
    "      continue",
    "    fi",
    '    child_path="$(_quest_child_path "$command_path|$token")"',
    '    if [[ -n "$child_path" ]]; then',
    '      command_path="$child_path"',
    "      argument_index=0",
    "    else",
    "      (( argument_index += 1 ))",
    "    fi",
    "    (( index += 1 ))",
    "  done",
    "",
    `  if (( CURRENT > 2 )); then previous="\${words[CURRENT - 1]}"; else previous=""; fi`,
    '  value_option="$previous"',
    '  if [[ -n "$pending_option" ]]; then value_option="$pending_option"; fi',
    '  arity="$(_quest_option_arity "$command_path|$value_option")"',
    '  if [[ "$current" != -* && "$previous" != *=* && ( "$arity" == required || "$arity" == optional || "$arity" == required-variadic || "$arity" == optional-variadic ) ]]; then',
    '    choices="$(_quest_option_values "$command_path|$value_option")"',
    '    if [[ -n "$choices" ]]; then',
    `      matches=("\${(@s: :)choices}")`,
    `      compadd -Q -- "\${matches[@]}"`,
    "      return 0",
    "    fi",
    '    if [[ "$(_quest_option_file_paths "$command_path|$value_option")" == yes ]]; then',
    "      _files",
    "    fi",
    "    return 0",
    "  fi",
    '  if [[ "$current" == -*=* ]]; then',
    `    option="\${current%%=*}"`,
    `    value="\${current#*=}"`,
    '    choices="$(_quest_option_values "$command_path|$option")"',
    '    if [[ -n "$choices" ]]; then',
    "      matches=()",
    `      for candidate in "\${(@s: :)choices}"; do`,
    '        if [[ "$candidate" == "$value"* ]]; then',
    '          matches+=("$option=$candidate")',
    "        fi",
    "      done",
    `      compadd -Q -- "\${matches[@]}"`,
    "      return 0",
    "    fi",
    '    if [[ "$(_quest_option_file_paths "$command_path|$option")" == yes ]]; then',
    '      compset -P "$option="',
    "      _files",
    "    fi",
    "    return 0",
    "  fi",
    '  if [[ "$current" == -?* && "$current" != --* ]]; then',
    '    for option in $(_quest_attached_options "$command_path"); do',
    `      if [[ "$current" == "$option"* && "\${#current}" -gt "\${#option}" ]]; then`,
    `        value="\${current:\${#option}}"`,
    '        choices="$(_quest_option_values "$command_path|$option")"',
    '        if [[ -n "$choices" ]]; then',
    "          matches=()",
    `          for candidate in "\${(@s: :)choices}"; do`,
    '            if [[ "$candidate" == "$value"* ]]; then',
    '              matches+=("$option$candidate")',
    "            fi",
    "          done",
    `          compadd -Q -- "\${matches[@]}"`,
    "          return 0",
    "        fi",
    '        if [[ "$(_quest_option_file_paths "$command_path|$option")" == yes ]]; then',
    '          compset -P "$option"',
    "          _files",
    "        fi",
    "        return 0",
    "      fi",
    "    done",
    "  fi",
    '  if [[ "$current" == -* ]]; then',
    '    choices="$(_quest_options "$command_path")"',
    `    matches=("\${(@s: :)choices}")`,
    `    compadd -Q -- "\${matches[@]}"`,
    "    return 0",
    "  fi",
    "  if (( argument_index == 0 )); then",
    '    choices="$(_quest_children "$command_path")"',
    '    if [[ -n "$choices" ]]; then',
    `      matches=("\${(@s: :)choices}")`,
    `      compadd -Q -- "\${matches[@]}"`,
    "      return 0",
    "    fi",
    "  fi",
    '  choices="$(_quest_argument_values "$command_path|$argument_index")"',
    '  if [[ -n "$choices" ]]; then',
    `    matches=("\${(@s: :)choices}")`,
    `    compadd -Q -- "\${matches[@]}"`,
    "    return 0",
    "  fi",
    '  if [[ "$(_quest_argument_file_paths "$command_path|$argument_index")" == yes ]]; then',
    "    _files",
    "  fi",
    "",
  ];
  return lines.join("\n");
}

function renderFishLookup(name: string, entries: readonly LookupEntry[]): string[] {
  return [
    `function ${name}`,
    '  switch "$argv[1]"',
    ...entries.flatMap((entry) => [
      `    case ${quoteShell(entry.key)}`,
      `      printf '%s\\n' ${entry.values.map(quoteShell).join(" ")}`,
    ]),
    "  end",
    "end",
    "",
  ];
}

function renderFishFileOptionRules(model: CompletionModel): string[] {
  const shortFlags = [
    ...new Set(
      model.commands.flatMap((command) =>
        command.options.flatMap((option) =>
          option.filePath
            ? option.flags.filter((flag) => flag.length === 2 && flag.startsWith("-"))
            : [],
        ),
      ),
    ),
  ];
  return shortFlags.map(
    (flag) => `complete -c quest -s ${quoteShell(flag.slice(1))} -r -n '__quest_file_context' -F`,
  );
}

function renderFishCompletion(model: CompletionModel): string {
  const lines = [
    "# fish completion for quest. Generated from the Commander command tree.",
    "",
    ...renderFishLookup(
      "__quest_children",
      listLookupEntries(model, (command) => command.children.map((child) => child.name)),
    ),
    ...renderFishLookup(
      "__quest_options",
      listLookupEntries(model, (command) => command.options.flatMap((option) => option.flags)),
    ),
    ...renderFishLookup("__quest_option_arity", optionArityEntries(model)),
    ...renderFishLookup("__quest_option_values", optionValueEntries(model)),
    ...renderFishLookup("__quest_option_file_paths", optionFilePathEntries(model)),
    ...renderFishLookup("__quest_argument_values", argumentValueEntries(model)),
    ...renderFishLookup("__quest_argument_file_paths", argumentFilePathEntries(model)),
    ...renderFishLookup("__quest_file_options", filePathOptionEntries(model)),
    ...renderFishLookup("__quest_attached_options", attachedOptionEntries(model)),
    ...renderFishLookup("__quest_child_path", childPathEntries(model)),
    "function __quest_filter",
    '  set -l current "$argv[1]"',
    "  for candidate in $argv[2..-1]",
    '    if string match -q -- "$current*" "$candidate"',
    "      printf '%s\\n' \"$candidate\"",
    "    end",
    "  end",
    "end",
    "",
    "function __quest_file_context",
    "  set -l current (commandline -ct)",
    `  set -l file_options (__quest_file_options ${quoteShell(ROOT_COMMAND_KEY)})`,
    "  if string match -q -- '-*=*' \"$current\"",
    "    set -l option (string replace -r '=.*$' '' -- \"$current\")",
    '    contains -- "$option" $file_options',
    "    return 1",
    "  end",
    "  if string match -q -- '-?*' \"$current\"; and not string match -q -- '--*' \"$current\"",
    "    for option in $file_options",
    '      if string match -q -- "$option*" "$current"; and test (string length "$current") -gt (string length "$option")',
    "        return 1",
    "      end",
    "    end",
    "  end",
    "  set -l tokens (commandline -opc)",
    `  set -l command_path ${quoteShell(ROOT_COMMAND_KEY)}`,
    "  set -l index 1",
    "  set -l argument_index 0",
    "  set -l token",
    "  set -l arity",
    "  set -l pending_option",
    "  set -l option",
    "  set -l child_path",
    "  if test (count $tokens) -gt 0",
    "    set index 2",
    "  end",
    "  while test $index -le (count $tokens)",
    '    set token "$tokens[$index]"',
    "    if string match -q -- '-*' \"$token\"",
    '      set pending_option ""',
    "      if not string match -q -- '*=*' \"$token\"",
    '        set arity (__quest_option_arity "$command_path|$token")',
    '        if test "$arity" = required',
    "          if test (math $index + 1) -le (count $tokens)",
    "            set index (math $index + 2)",
    "          else",
    '            set pending_option "$token"',
    "            set index (math $index + 1)",
    "          end",
    "          continue",
    "        end",
    '        if test "$arity" = optional',
    "          if test (math $index + 1) -le (count $tokens); and not string match -q -- '-*' \"$tokens[(math $index + 1)]\"",
    "            set index (math $index + 2)",
    "          else",
    '            set pending_option "$token"',
    "            set index (math $index + 1)",
    "          end",
    "          continue",
    "        end",
    '        if test "$arity" = required-variadic; or test "$arity" = optional-variadic',
    '          set pending_option "$token"',
    "          set index (math $index + 1)",
    "          while test $index -le (count $tokens)",
    "            if string match -q -- '-*' \"$tokens[$index]\"",
    "              break",
    "            end",
    "            set index (math $index + 1)",
    "          end",
    "          continue",
    "        end",
    "      else",
    "        set option (string replace -r '=.*$' '' -- \"$token\")",
    '        set arity (__quest_option_arity "$command_path|$option")',
    '        if test "$arity" = required-variadic; or test "$arity" = optional-variadic',
    '          set pending_option "$option"',
    "          set index (math $index + 1)",
    "          while test $index -le (count $tokens)",
    "            if string match -q -- '-*' \"$tokens[$index]\"",
    "              break",
    "            end",
    "            set index (math $index + 1)",
    "          end",
    "          continue",
    "        end",
    "      end",
    "      set index (math $index + 1)",
    "      continue",
    "    end",
    '    set child_path (__quest_child_path "$command_path|$token")',
    '    if test (count $child_path) -gt 0; and test -n "$child_path[1]"',
    '      set command_path "$child_path[1]"',
    "      set argument_index 0",
    "    else",
    "      set argument_index (math $argument_index + 1)",
    "    end",
    "    set index (math $index + 1)",
    "  end",
    '  if test -n "$pending_option"; and contains -- "$pending_option" $file_options',
    "    return 0",
    "  end",
    "  if string match -q -- '-*' \"$current\"",
    "    return 1",
    "  end",
    '  set -l argument_path (__quest_argument_file_paths "$command_path|$argument_index")',
    '  if test (count $argument_path) -gt 0; and test "$argument_path[1]" = yes',
    "    return 0",
    "  end",
    "  return 1",
    "end",
    "",
    "function __quest_prefixed_files",
    '  set -l prefix "$argv[1]"',
    '  set -l value "$argv[2]"',
    '  set -l completions (__fish_complete_path "$value")',
    "  for completion in $completions",
    "    set -l path (string replace -r '\\t.*$' '' -- \"$completion\")",
    '    printf \'%s%s\\n\' "$prefix" "$path"',
    "  end",
    "end",
    "",
    "function __quest_complete",
    "  set -l tokens (commandline -opc)",
    "  set -l current (commandline -ct)",
    `  set -l command_path ${quoteShell(ROOT_COMMAND_KEY)}`,
    "  set -l index 1",
    "  set -l argument_index 0",
    "  set -l token",
    "  set -l arity",
    "  set -l child_path",
    "  set -l previous",
    "  set -l pending_option",
    "  set -l value_option",
    "  set -l file_path",
    "  set -l choices",
    "  set -l candidates",
    "  set -l option",
    "  set -l value",
    "  set -l candidate",
    "  if test (count $tokens) -gt 0",
    "    set index 2",
    "  end",
    "",
    "  while test $index -le (count $tokens)",
    '    set token "$tokens[$index]"',
    "    if string match -q -- '-*' \"$token\"",
    '      set pending_option ""',
    "      if not string match -q -- '*=*' \"$token\"",
    '        set arity (__quest_option_arity "$command_path|$token")',
    '        if test "$arity" = required; or test "$arity" = optional',
    "          set index (math $index + 2)",
    "          continue",
    "        end",
    '        if test "$arity" = required-variadic; or test "$arity" = optional-variadic',
    '          set pending_option "$token"',
    "          set index (math $index + 1)",
    "          while test $index -le (count $tokens)",
    "            if string match -q -- '-*' \"$tokens[$index]\"",
    "              break",
    "            end",
    "            set index (math $index + 1)",
    "          end",
    "          continue",
    "        end",
    "      else",
    "        set option (string replace -r '=.*$' '' -- \"$token\")",
    '        set arity (__quest_option_arity "$command_path|$option")',
    '        if test "$arity" = required-variadic; or test "$arity" = optional-variadic',
    '          set pending_option "$option"',
    "          set index (math $index + 1)",
    "          while test $index -le (count $tokens)",
    "            if string match -q -- '-*' \"$tokens[$index]\"",
    "              break",
    "            end",
    "            set index (math $index + 1)",
    "          end",
    "          continue",
    "        end",
    "      end",
    "      set index (math $index + 1)",
    "      continue",
    "    end",
    '    set child_path (__quest_child_path "$command_path|$token")',
    '    if test (count $child_path) -gt 0; and test -n "$child_path[1]"',
    '      set command_path "$child_path[1]"',
    "      set argument_index 0",
    "    else",
    "      set argument_index (math $argument_index + 1)",
    "    end",
    "    set index (math $index + 1)",
    "  end",
    "",
    "  if test (count $tokens) -gt 0",
    '    set previous "$tokens[-1]"',
    "  else",
    '    set previous ""',
    "  end",
    '  set value_option "$previous"',
    '  if test -n "$pending_option"',
    '    set value_option "$pending_option"',
    "  end",
    '  set arity (__quest_option_arity "$command_path|$value_option")',
    '  if not string match -q -- \'-*\' "$current"; and not string match -q -- \'*=*\' "$previous"; and test "$arity" != none; and test -n "$arity"',
    '    set choices (__quest_option_values "$command_path|$value_option")',
    "    if test (count $choices) -gt 0",
    '      __quest_filter "$current" $choices',
    "      return",
    "    end",
    '    set file_path (__quest_option_file_paths "$command_path|$value_option")',
    '    if test (count $file_path) -gt 0; and test "$file_path[1]" = yes',
    "      return",
    "    end",
    "    return",
    "  end",
    "  if string match -q -- '-*=*' \"$current\"",
    "    set option (string replace -r '=.*$' '' -- \"$current\")",
    "    set value (string replace -r '^[^=]*=' '' -- \"$current\")",
    '    set choices (__quest_option_values "$command_path|$option")',
    "    if test (count $choices) -gt 0",
    "      for candidate in $choices",
    '        if string match -q -- "$value*" "$candidate"',
    '          printf \'%s=%s\\n\' "$option" "$candidate"',
    "        end",
    "      end",
    "      return",
    "    end",
    '    set file_path (__quest_option_file_paths "$command_path|$option")',
    '    if test (count $file_path) -gt 0; and test "$file_path[1]" = yes',
    '      __quest_prefixed_files "$option=" "$value"',
    "      return",
    "    end",
    "    return",
    "  end",
    "  if string match -q -- '-?*' \"$current\"; and not string match -q -- '--*' \"$current\"",
    '    set candidates (__quest_attached_options "$command_path")',
    "    for option in $candidates",
    '      if string match -q -- "$option*" "$current"; and test (string length "$current") -gt (string length "$option")',
    '        set value (string sub -s (math (string length "$option") + 1) -- "$current")',
    '        set choices (__quest_option_values "$command_path|$option")',
    "        if test (count $choices) -gt 0",
    "          for candidate in $choices",
    '            if string match -q -- "$value*" "$candidate"',
    '              printf \'%s%s\\n\' "$option" "$candidate"',
    "            end",
    "          end",
    "          return",
    "        end",
    '        set file_path (__quest_option_file_paths "$command_path|$option")',
    '        if test (count $file_path) -gt 0; and test "$file_path[1]" = yes',
    '          __quest_prefixed_files "$option" "$value"',
    "          return",
    "        end",
    "        return",
    "      end",
    "    end",
    "  end",
    "  if string match -q -- '-*' \"$current\"",
    '    set candidates (__quest_options "$command_path")',
    '    __quest_filter "$current" $candidates',
    "    return",
    "  end",
    "  if test $argument_index -eq 0",
    '    set candidates (__quest_children "$command_path")',
    "    if test (count $candidates) -gt 0",
    '      __quest_filter "$current" $candidates',
    "      return",
    "    end",
    "  end",
    '  set choices (__quest_argument_values "$command_path|$argument_index")',
    "  if test (count $choices) -gt 0",
    '    __quest_filter "$current" $choices',
    "    return",
    "  end",
    '  set file_path (__quest_argument_file_paths "$command_path|$argument_index")',
    '  if test (count $file_path) -gt 0; and test "$file_path[1]" = yes',
    "    return",
    "  end",
    "end",
    "",
    ...renderFishFileOptionRules(model),
    "complete -c quest -f -a '(__quest_complete)'",
    "complete -c quest -n '__quest_file_context' -F",
    "",
  ];
  return lines.join("\n");
}

export function generateShellCompletions(program: Command, shell: CompletionShell): string {
  const model = buildCompletionModel(program);
  switch (shell) {
    case "bash":
      return renderBashCompletion(model);
    case "fish":
      return renderFishCompletion(model);
    case "zsh":
      return renderZshCompletion(model);
  }
}
