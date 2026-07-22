import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const { store } = vi.hoisted(() => ({ store: new Map<string, string>() }));
vi.mock('./timers', () => ({
  getSetting: (k: string) => store.get(k),
  setSetting: (k: string, v: string) => { store.set(k, v); },
}));

import {
  getWorkspaces, isKnownWorkspace, isDeclinedPath, declineWorkspace,
  getManagedFeatureIds, addManagedFeatureId, removeManagedFeatureId,
  WORKSPACE_PATHS_KEY, MANAGED_FEATURES_KEY,
  featureFolderName, createFeatureFolder,
  registerWorkspace, ensureWorkspaceScaffold, SEED_KEY,
  getActiveFeature, setActiveFeature, clearActiveFeature, ACTIVE_FEATURE_KEY,
} from './workspace';

beforeEach(() => store.clear());

describe('workspace settings state', () => {
  it('getWorkspaces returns empty arrays when unset', () => {
    expect(getWorkspaces()).toEqual({ paths: [], declined: [] });
  });

  it('getWorkspaces parses garbage as empty', () => {
    store.set(WORKSPACE_PATHS_KEY, 'not json');
    expect(getWorkspaces().paths).toEqual([]);
  });

  it('isKnownWorkspace matches exact path and sub-paths', () => {
    store.set(WORKSPACE_PATHS_KEY, JSON.stringify(['/w/space']));
    expect(isKnownWorkspace('/w/space')).toBe(true);
    expect(isKnownWorkspace('/w/space/426639-x')).toBe(true);
    expect(isKnownWorkspace('/w/other')).toBe(false);
  });

  it('declineWorkspace records path; isDeclinedPath matches; dedups', () => {
    declineWorkspace('/w/nope');
    declineWorkspace('/w/nope');
    expect(isDeclinedPath('/w/nope')).toBe(true);
    expect(getWorkspaces().declined).toEqual(['/w/nope']);
  });

  it('managed feature ids: add (dedup number), read, remove', () => {
    addManagedFeatureId(426639);
    addManagedFeatureId(426639);
    addManagedFeatureId(431000);
    expect(getManagedFeatureIds()).toEqual([426639, 431000]);
    removeManagedFeatureId(426639);
    expect(getManagedFeatureIds()).toEqual([431000]);
  });

  it('getManagedFeatureIds parses garbage as empty', () => {
    store.set(MANAGED_FEATURES_KEY, '{oops');
    expect(getManagedFeatureIds()).toEqual([]);
  });
});

describe('featureFolderName', () => {
  it('slugs the title: lowercase, punctuation to dashes, capped', () => {
    const name = featureFolderName(
      426639,
      'Declarative Continuous Deployment (CD) and Automated Testing Pipeline',
    );
    expect(name.startsWith('426639-')).toBe(true);
    expect(name).toMatch(/^426639-[a-z0-9-]+$/);
    expect(name.length).toBeLessThanOrEqual(48); // id + '-' + <=40 slug
    expect(name).not.toContain('(');
    expect(name).not.toMatch(/--/);       // collapsed
    expect(name.endsWith('-')).toBe(false); // trimmed
  });

  it('handles an empty/symbol-only title with just the id', () => {
    expect(featureFolderName(12, '!!!')).toBe('12');
  });
});

describe('createFeatureFolder', () => {
  it('creates the folder and reports created, then false on repeat', () => {
    const root = mkdtempSync(join(tmpdir(), 'sh-ws-'));
    try {
      const first = createFeatureFolder(root, 426639, 'Declarative CD');
      expect(existsSync(first.path)).toBe(true);
      expect(first.created).toBe(true);
      const second = createFeatureFolder(root, 426639, 'Declarative CD');
      expect(second.path).toBe(first.path);
      expect(second.created).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function makeSeed(): string {
  const seed = mkdtempSync(join(tmpdir(), 'sh-seed-'));
  mkdirSync(join(seed, '_bmad'), { recursive: true });
  writeFileSync(join(seed, '_bmad', 'config.yaml'), 'x');
  mkdirSync(join(seed, '.claude', 'skills', 'bmad-x'), { recursive: true });
  writeFileSync(join(seed, '.claude', 'skills', 'bmad-x', 'SKILL.md'), 'x');
  mkdirSync(join(seed, '.claude', 'hooks'), { recursive: true });
  writeFileSync(join(seed, '.claude', 'hooks', 'user-prompt-submit.sh'), '#!/bin/bash\n');
  writeFileSync(join(seed, 'CLAUDE.md'), '# rules');
  return seed;
}

describe('ensureWorkspaceScaffold', () => {
  it('copies bmad, claude-md, hook into an empty workspace; skips on repeat', () => {
    const seed = makeSeed();
    const ws = mkdtempSync(join(tmpdir(), 'sh-ws2-'));
    try {
      store.set(SEED_KEY, seed);
      const first = ensureWorkspaceScaffold(ws);
      expect(first.seedMissing).toBe(false);
      expect(first.created.sort()).toEqual(['bmad', 'claude-md', 'hook'].sort());
      expect(existsSync(join(ws, '_bmad', 'config.yaml'))).toBe(true);
      expect(existsSync(join(ws, 'CLAUDE.md'))).toBe(true);
      expect(existsSync(join(ws, '.claude', 'hooks', 'user-prompt-submit.sh'))).toBe(true);
      expect(existsSync(join(ws, '.claude', 'settings.json'))).toBe(true);
      const second = ensureWorkspaceScaffold(ws);
      expect(second.created).toEqual([]); // nothing re-copied
    } finally {
      rmSync(seed, { recursive: true, force: true });
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('syncs a NEW seed skill into an already-scaffolded workspace, without clobbering existing skills', () => {
    const seed = makeSeed();
    const ws = mkdtempSync(join(tmpdir(), 'sh-ws-sync-'));
    try {
      store.set(SEED_KEY, seed);
      // First scaffold: workspace gets bmad + the seed's bmad-x skill.
      ensureWorkspaceScaffold(ws);
      expect(existsSync(join(ws, '.claude', 'skills', 'bmad-x', 'SKILL.md'))).toBe(true);
      // User edits their copy of an existing skill.
      writeFileSync(join(ws, '.claude', 'skills', 'bmad-x', 'SKILL.md'), 'EDITED');
      // A new skill lands in the seed AFTER the workspace was created.
      mkdirSync(join(seed, '.claude', 'skills', 'discovery'), { recursive: true });
      writeFileSync(join(seed, '.claude', 'skills', 'discovery', 'SKILL.md'), 'discovery');
      // Re-scaffold: the new skill is delivered; the edited one is left alone.
      const r = ensureWorkspaceScaffold(ws);
      expect(r.created).toContain('skill:discovery');
      expect(existsSync(join(ws, '.claude', 'skills', 'discovery', 'SKILL.md'))).toBe(true);
      expect(readFileSync(join(ws, '.claude', 'skills', 'bmad-x', 'SKILL.md'), 'utf8')).toBe('EDITED');
      // Idempotent: running again copies nothing new.
      const again = ensureWorkspaceScaffold(ws);
      expect(again.created).toEqual([]);
    } finally {
      rmSync(seed, { recursive: true, force: true });
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('reports seedMissing when the seed has no _bmad', () => {
    const emptySeed = mkdtempSync(join(tmpdir(), 'sh-noseed-'));
    const ws = mkdtempSync(join(tmpdir(), 'sh-ws3-'));
    try {
      store.set(SEED_KEY, emptySeed);
      const r = ensureWorkspaceScaffold(ws);
      expect(r.seedMissing).toBe(true);
      expect(r.created).toEqual([]);
    } finally {
      rmSync(emptySeed, { recursive: true, force: true });
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('writes settings.json even when hook already exists (FINDING A)', () => {
    const seed = makeSeed();
    const ws = mkdtempSync(join(tmpdir(), 'sh-ws-settings-'));
    try {
      store.set(SEED_KEY, seed);
      // Pre-populate workspace with hook but no settings.json
      mkdirSync(join(ws, '.claude', 'hooks'), { recursive: true });
      writeFileSync(join(ws, '.claude', 'hooks', 'user-prompt-submit.sh'), '#!/bin/bash\n');
      const r = ensureWorkspaceScaffold(ws);
      expect(existsSync(join(ws, '.claude', 'settings.json'))).toBe(true);
      expect(r.created).not.toContain('hook'); // hook wasn't created this time
    } finally {
      rmSync(seed, { recursive: true, force: true });
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('handles incomplete seed with _bmad but no hook (FINDING B)', () => {
    const incompleteSeed = mkdtempSync(join(tmpdir(), 'sh-incomplete-'));
    const ws = mkdtempSync(join(tmpdir(), 'sh-ws-incomplete-'));
    try {
      mkdirSync(join(incompleteSeed, '_bmad'), { recursive: true });
      writeFileSync(join(incompleteSeed, '_bmad', 'config.yaml'), 'x');
      // No hook in seed
      store.set(SEED_KEY, incompleteSeed);
      const r = ensureWorkspaceScaffold(ws);
      expect(r.seedMissing).toBe(false);
      expect(r.created).toContain('bmad');
      expect(r.created).not.toContain('hook'); // hook wasn't in seed, so not created
      expect(existsSync(join(ws, '_bmad', 'config.yaml'))).toBe(true);
      expect(existsSync(join(ws, '.claude', 'hooks', 'user-prompt-submit.sh'))).toBe(false);
    } finally {
      rmSync(incompleteSeed, { recursive: true, force: true });
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe('registerWorkspace', () => {
  it('adds the path, dedups, and scaffolds', () => {
    const seed = makeSeed();
    const ws = mkdtempSync(join(tmpdir(), 'sh-ws4-'));
    try {
      store.set(SEED_KEY, seed);
      const r = registerWorkspace(ws);
      expect(r.path).toBe(resolve(ws));
      expect(r.scaffolded.length).toBe(3);
      expect(getWorkspaces().paths).toContain(resolve(ws));
      registerWorkspace(ws); // dedup
      expect(getWorkspaces().paths.filter(p => p === resolve(ws)).length).toBe(1);
    } finally {
      rmSync(seed, { recursive: true, force: true });
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('un-declines a previously declined path', () => {
    const seed = makeSeed();
    const ws = mkdtempSync(join(tmpdir(), 'sh-ws5-'));
    try {
      store.set(SEED_KEY, seed);
      declineWorkspace(ws);
      expect(isDeclinedPath(ws)).toBe(true);
      registerWorkspace(ws);
      expect(getWorkspaces().declined).not.toContain(resolve(ws));
      expect(isDeclinedPath(ws)).toBe(false);
    } finally {
      rmSync(seed, { recursive: true, force: true });
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe('active feature', () => {
  const sample = {
    id: 426639,
    title: 'Declarative CD',
    folderPath: '/w/space/426639-declarative-cd',
    setAt: '2026-07-16T10:00:00.000Z',
  };

  it('returns null when unset', () => {
    expect(getActiveFeature()).toBeNull();
  });

  it('set then get round-trips the record', () => {
    setActiveFeature(sample);
    expect(getActiveFeature()).toEqual(sample);
  });

  it('set overwrites the previous active feature (overwrite is the switch)', () => {
    setActiveFeature(sample);
    const next = { id: 431000, title: 'Other', folderPath: '/w/space/431000-other', setAt: '2026-07-16T11:00:00.000Z' };
    setActiveFeature(next);
    expect(getActiveFeature()).toEqual(next);
  });

  it('clear resets to null', () => {
    setActiveFeature(sample);
    clearActiveFeature();
    expect(getActiveFeature()).toBeNull();
  });

  it('parses garbage as null (never throws)', () => {
    store.set(ACTIVE_FEATURE_KEY, '{not json');
    expect(getActiveFeature()).toBeNull();
  });

  it('parses a non-object / wrong-shape value as null', () => {
    store.set(ACTIVE_FEATURE_KEY, JSON.stringify([1, 2, 3]));
    expect(getActiveFeature()).toBeNull();
    store.set(ACTIVE_FEATURE_KEY, JSON.stringify({ id: 'nope', title: 5 }));
    expect(getActiveFeature()).toBeNull();
  });
});
