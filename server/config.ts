/**
 * sprint-helper backend config.
 *
 * Reads Azure DevOps org/project/team from `az` CLI defaults so the user
 * doesn't have to maintain a separate config file. Falls back to env vars.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

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

  cached = { organization, project, team, user };
  return cached;
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
