import { describe, it, expect } from 'vitest';
import { htmlPreview } from './html-preview';

describe('htmlPreview', () => {
  it('returns undefined for undefined or empty input', () => {
    expect(htmlPreview(undefined)).toBeUndefined();
    expect(htmlPreview('')).toBeUndefined();
    expect(htmlPreview('   ')).toBeUndefined();
    expect(htmlPreview('<p></p>')).toBeUndefined();
  });

  it('strips tags and decodes entities into plain text', () => {
    expect(htmlPreview('<p>Move CI/CD to <b>GitHub</b> &amp; test</p>'))
      .toBe('Move CI/CD to GitHub & test');
  });

  it('turns <br> and </p> into spaces and collapses whitespace', () => {
    expect(htmlPreview('<p>one</p><p>two</p><div>three<br/>four</div>'))
      .toBe('one two three four');
  });

  it('truncates to 280 chars with an ellipsis', () => {
    const long = 'x'.repeat(400);
    const out = htmlPreview(long)!;
    expect(out.length).toBe(278);
    expect(out.endsWith('…')).toBe(true);
  });
});
