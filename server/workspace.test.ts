import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
