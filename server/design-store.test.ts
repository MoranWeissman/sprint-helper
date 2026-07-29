// server/design-store.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  readDesignDoc, writeDesignDoc, listDesignMeetings, listDiagrams, diagramPath,
} from './design-store';
import { emptyDesignDoc } from './design';
import { listMeetings, hasHtmlArtifact } from './discovery-store';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'design-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('design-store', () => {
  it('reads null with no design/ folder; round-trips after write', () => {
    expect(readDesignDoc(dir)).toBeNull();

    const doc = emptyDesignDoc();
    doc.approach.lines = ['Use a shared queue.'];
    writeDesignDoc(dir, doc, { featureDisplayName: '**Declarative CD** (#100)' });

    expect(existsSync(join(dir, 'design', 'design.json'))).toBe(true);
    expect(existsSync(join(dir, 'design', 'design.md'))).toBe(true);
    expect(readFileSync(join(dir, 'design', 'design.md'), 'utf8')).toContain('## The approach');
    expect(readDesignDoc(dir)!.approach.lines).toEqual(['Use a shared queue.']);
  });

  it('listDesignMeetings reads design/meetings/*.md and ignores sources/; missing folder -> []', () => {
    expect(listDesignMeetings(dir)).toEqual([]);

    const meetingsDir = join(dir, 'design', 'meetings');
    mkdirSync(meetingsDir, { recursive: true });
    writeFileSync(join(meetingsDir, '2026-07-28.md'), '# Design review\nAgreed on the approach.');
    mkdirSync(join(meetingsDir, 'sources'), { recursive: true });
    writeFileSync(join(meetingsDir, 'sources', 'transcript.md'), '# Should be ignored\nRaw transcript.');

    const out = listDesignMeetings(dir);
    expect(out.map(m => m.file)).toEqual(['2026-07-28.md']);
    expect(out[0].title).toBe('Design review');
  });

  it('listMeetings (discovery) still works — regression on the extraction', () => {
    expect(listMeetings(dir)).toEqual([]);
    const discoMeetings = join(dir, 'discovery', 'meetings');
    mkdirSync(discoMeetings, { recursive: true });
    writeFileSync(join(discoMeetings, '2026-07-20.md'), '# Kickoff\nFirst talk.');
    const out = listMeetings(dir);
    expect(out.map(m => m.file)).toEqual(['2026-07-20.md']);
    expect(out[0].title).toBe('Kickoff');
  });

  it('listDiagrams returns only .svg names, sorted; diagramPath rejects unsafe/wrong-ext names', () => {
    expect(listDiagrams(dir)).toEqual([]);

    const diagramsDir = join(dir, 'design', 'diagrams');
    mkdirSync(diagramsDir, { recursive: true });
    writeFileSync(join(diagramsDir, 'b-flow.svg'), '<svg></svg>');
    writeFileSync(join(diagramsDir, 'a-flow.svg'), '<svg></svg>');
    writeFileSync(join(diagramsDir, 'notes.txt'), 'not a diagram');

    expect(listDiagrams(dir)).toEqual(['a-flow.svg', 'b-flow.svg']);

    expect(diagramPath(dir, '../evil.svg')).toBeNull();
    expect(diagramPath(dir, 'x.png')).toBeNull();
    expect(diagramPath(dir, 'deploy-flow.svg')).toBe(join(dir, 'design', 'diagrams', 'deploy-flow.svg'));
  });

  it('hasHtmlArtifact for design-walkthrough flips true after writing design/walkthrough.html; walkthrough still resolves to demo/', () => {
    expect(hasHtmlArtifact(dir, 'design-walkthrough')).toBe(false);
    mkdirSync(join(dir, 'design'), { recursive: true });
    writeFileSync(join(dir, 'design', 'walkthrough.html'), '<!doctype html><title>w</title>');
    expect(hasHtmlArtifact(dir, 'design-walkthrough')).toBe(true);

    expect(hasHtmlArtifact(dir, 'walkthrough')).toBe(false);
    mkdirSync(join(dir, 'demo'), { recursive: true });
    writeFileSync(join(dir, 'demo', 'walkthrough.html'), '<!doctype html><title>w</title>');
    expect(hasHtmlArtifact(dir, 'walkthrough')).toBe(true);
  });
});
