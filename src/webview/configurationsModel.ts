import {
  EMPTY_CONFIGURATION_STATE,
  activateConfiguration,
  addConfiguration,
  removeConfiguration,
  renameConfiguration,
  renameVariableInConfigurations,
  setConfigurationCell,
  validateConfigurationState,
  type ConfigurationResult,
  type ConfigurationState,
} from "../configurations";

/**
 * In-webview store of the document's configurations (design table). Pure data
 * (no DOM) over the immutable helpers in `configurations.ts`; every mutation
 * fires `onChange` (re-resolve, re-render, persist). {@link load} replaces the
 * state WITHOUT firing — the initial load from disk must not echo back as a
 * write. Mutators return the refusal text (or null) so the panel can report it.
 */
export class ConfigurationsModel {
  private current: ConfigurationState = EMPTY_CONFIGURATION_STATE;

  constructor(private readonly onChangeFn: () => void) {}

  load(configurations: unknown, active: unknown): void {
    this.current = validateConfigurationState(configurations, active);
  }

  get state(): ConfigurationState {
    return JSON.parse(JSON.stringify(this.current)) as ConfigurationState;
  }

  get active(): string | null {
    return this.current.activeConfiguration;
  }

  private apply(res: ConfigurationResult): string | null {
    if (res.error) return res.error;
    this.current = res.state;
    this.onChangeFn();
    return null;
  }

  add(name: string, copyFrom?: string): string | null {
    return this.apply(addConfiguration(this.current, name, copyFrom));
  }

  remove(name: string): string | null {
    return this.apply(removeConfiguration(this.current, name));
  }

  rename(from: string, to: string): string | null {
    if (from === to) return null;
    return this.apply(renameConfiguration(this.current, from, to));
  }

  /** Make `name` the applied configuration; null returns to the plain variables. */
  activate(name: string | null): string | null {
    if (this.current.activeConfiguration === name) return null;
    return this.apply(activateConfiguration(this.current, name));
  }

  setCell(name: string, variable: string, expr: string, baseExpr?: string): string | null {
    const before = this.current;
    const res = setConfigurationCell(this.current, name, variable, expr, baseExpr);
    if (!res.error && JSON.stringify(res.state) === JSON.stringify(before)) return null;
    return this.apply(res);
  }

  /** A variable was renamed: keep every configuration's override attached to it. */
  renameVariable(from: string, to: string): void {
    const next = renameVariableInConfigurations(this.current, from, to);
    if (JSON.stringify(next) === JSON.stringify(this.current)) return;
    this.current = next;
    this.onChangeFn();
  }
}
