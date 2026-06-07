/**
 * sprint-helper backend config.
 *
 * In CLI mode, reads Azure DevOps org/project/team from `az` CLI defaults so
 * the user doesn't have to maintain a separate config file (env vars override).
 * In API mode there's no `az` to ask, so the same four values come from stored
 * settings (or env). Which mode is active is decided in ./ado-client.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getAdoAccessMode } from './ado-client';
import { getSetting } from './timers';

const exec = promisify(execFile);

export interface AdoConfig {
  organization: string;
  project: string;
  team: string;
  user: string;
}

let cached: AdoConfig | null = null;

export async function loadAdoConfig(): Promise<AdoConfig> {
  if (cached) return cached;
  cached = getAdoAccessMode() === 'api' ? loadConfigFromStore() : await loadConfigFromCli();
  return cached;
}

/** Forget the cached config so the next load re-reads it (e.g. after a mode switch). */
export function invalidateAdoConfig(): void {
  cached = null;
}

async function loadConfigFromCli(): Promise<AdoConfig> {
  const [organization, project, team, user] = await Promise.all([
    azDefault('organization') ?? process.env.SH_ADO_ORG,
    azDefault('project') ?? process.env.SH_ADO_PROJECT,
    resolveTeam(),
    resolveUser(),
  ]);

  if (!organization) throw new Error('ADO organization not configured. Run: az devops configure --defaults organization=https://dev.azure.com/<your-org>');
  if (!project) throw new Error('ADO project not configured. Run: az devops configure --defaults project=<your-project>');
  if (!team) throw new Error('ADO team not resolvable. Set SH_ADO_TEAM env var or ensure exactly one team exists in the project.');
  if (!user) throw new Error('ADO user not resolvable. Ensure `az login` succeeded.');

  return { organization, project, team, user };
}

/** API mode: org/project/team/user come from stored settings (env as fallback). */
function loadConfigFromStore(): AdoConfig {
  const organization = pick('ado_org', 'SH_ADO_ORG');
  const project = pick('ado_project', 'SH_ADO_PROJECT');
  const team = pick('ado_team', 'SH_ADO_TEAM');
  const user = pick('ado_user', 'SH_ADO_USER');

  if (!organization) throw new Error('API access mode: Azure DevOps organization not set. Save it as the "ado_org" setting (e.g. https://dev.azure.com/<your-org>).');
  if (!project) throw new Error('API access mode: Azure DevOps project not set. Save it as the "ado_project" setting.');
  if (!team) throw new Error('API access mode: Azure DevOps team not set. Save it as the "ado_team" setting.');
  if (!user) throw new Error('API access mode: your Azure DevOps identity not set. Save it as the "ado_user" setting (the email new items get assigned to).');

  return { organization, project, team, user };
}

function pick(settingKey: string, envKey: string): string | undefined {
  const fromSetting = getSetting(settingKey);
  if (fromSetting && fromSetting.trim()) return fromSetting.trim();
  const fromEnv = process.env[envKey];
  return fromEnv && fromEnv.trim() ? fromEnv.trim() : undefined;
}

async function azDefault(key: 'organization' | 'project'): Promise<string | undefined> {
  try {
    const { stdout } = await exec('az', ['devops', 'configure', '--list']);
    const match = stdout.match(new RegExp(`^${key}\\s*=\\s*(.+)$`, 'm'));
    return match?.[1].trim();
  } catch {
    return undefined;
  }
}

async function resolveTeam(): Promise<string | undefined> {
  if (process.env.SH_ADO_TEAM) return process.env.SH_ADO_TEAM;
  try {
    const { stdout } = await exec('az', ['devops', 'team', 'list', '--query', '[].name', '-o', 'tsv']);
    const teams = stdout.split('\n').map(s => s.trim()).filter(Boolean);
    if (teams.length === 1) return teams[0];
    return undefined;
  } catch {
    return undefined;
  }
}

async function resolveUser(): Promise<string | undefined> {
  try {
    const { stdout } = await exec('az', ['account', 'show', '--query', 'user.name', '-o', 'tsv']);
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}
