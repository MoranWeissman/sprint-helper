// server/discovery-store.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readDiscoveryDoc, writeDiscoveryDoc, discoveryStatus, DISCOVERY_MD, DISCOVERY_DIR, htmlArtifactPath, hasHtmlArtifact } from './discovery-store';
import { emptyDiscoveryDoc } from './discovery';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'disco-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('discovery-store', () => {
  it('reads null when no file / garbage file', () => {
    expect(readDiscoveryDoc(dir)).toBeNull();
    mkdirSync(join(dir, DISCOVERY_DIR), { recursive: true });
    writeFileSync(join(dir, DISCOVERY_DIR, 'discovery.json'), 'not json {');
    expect(readDiscoveryDoc(dir)).toBeNull();
  });

  it('writes the json AND a rendered markdown into the discovery/ subfolder', () => {
    const doc = emptyDiscoveryDoc();
    doc.problem = 'Move CD.';
    doc.flow = ['step 1'];
    writeDiscoveryDoc(dir, doc, '**Declarative CD** (#100)');
    expect(existsSync(join(dir, DISCOVERY_DIR, 'discovery.json'))).toBe(true);
    expect(existsSync(join(dir, DISCOVERY_DIR, DISCOVERY_MD))).toBe(true);
    expect(readFileSync(join(dir, DISCOVERY_DIR, DISCOVERY_MD), 'utf8')).toContain('# Discovery: **Declarative CD** (#100)');
    expect(readDiscoveryDoc(dir)!.problem).toBe('Move CD.');
  });

  it('still reads a legacy file written at the feature-folder root', () => {
    const doc = emptyDiscoveryDoc();
    doc.problem = 'Legacy root draft.';
    // Simulate a file written before the discovery/ split.
    writeFileSync(join(dir, 'discovery.json'), JSON.stringify(doc));
    expect(readDiscoveryDoc(dir)?.problem).toBe('Legacy root draft.');
  });

  it('discoveryStatus reports has/finished/demo from the folder', () => {
    expect(discoveryStatus(dir)).toEqual({
      hasDiscovery: false, finished: false, missing: expect.any(Array), demoStatus: 'none',
      hasWalkthrough: false, hasDemoHtml: false,
    });
    const doc = emptyDiscoveryDoc();
    doc.flow = ['s1', 's2'];
    doc.groups = [{ name: 'g', items: [
      { text: 'a', tags: ['diff'] }, { text: 'b', tags: ['risk'] }, { text: 'c', tags: ['fact'] },
    ] }];
    doc.demo.status = 'scheduled';
    writeDiscoveryDoc(dir, doc, '#100');
    const st = discoveryStatus(dir);
    expect(st.hasDiscovery).toBe(true);
    expect(st.finished).toBe(true);
    expect(st.demoStatus).toBe('scheduled');
    expect(st.hasWalkthrough).toBe(false);
    expect(st.hasDemoHtml).toBe(false);

    // Once the artifact files land, the status flips.
    mkdirSync(join(dir, 'demo'), { recursive: true });
    writeFileSync(join(dir, 'demo', 'walkthrough.html'), '<!doctype html><title>w</title>');
    expect(discoveryStatus(dir).hasWalkthrough).toBe(true);
    expect(discoveryStatus(dir).hasDemoHtml).toBe(false);
  });

  it('maps html artifact kinds to demo/ files and reports existence', () => {
    expect(htmlArtifactPath(dir, 'walkthrough')).toBe(join(dir, 'demo', 'walkthrough.html'));
    expect(htmlArtifactPath(dir, 'demo')).toBe(join(dir, 'demo', 'concept-demo.html'));

    expect(hasHtmlArtifact(dir, 'demo')).toBe(false);
    mkdirSync(join(dir, 'demo'), { recursive: true });
    writeFileSync(join(dir, 'demo', 'concept-demo.html'), '<!doctype html><title>x</title>');
    expect(hasHtmlArtifact(dir, 'demo')).toBe(true);
    expect(hasHtmlArtifact(dir, 'walkthrough')).toBe(false);
  });
});
