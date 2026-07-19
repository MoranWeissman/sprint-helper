import { describe, it, expect } from 'vitest';
import { selectLiveOutsideSprintIds } from './dashboard';

describe('selectLiveOutsideSprintIds', () => {
  it('returns live-session ids not in the sprint', () => {
    expect(selectLiveOutsideSprintIds([426639, 100], [100, 200]).sort())
      .toEqual([426639]);
  });
  it('empty when every live session is in the sprint', () => {
    expect(selectLiveOutsideSprintIds([100, 200], [100, 200])).toEqual([]);
  });
  it('dedups repeated live ids', () => {
    expect(selectLiveOutsideSprintIds([426639, 426639], [])).toEqual([426639]);
  });
  it('empty when no live sessions', () => {
    expect(selectLiveOutsideSprintIds([], [100])).toEqual([]);
  });
});
