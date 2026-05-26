import type { DashboardData } from './types';

// Anchor the mock sprint so "today" is day 6 of 10 regardless of when the dashboard is opened.
function sprintStartAnchor(): Date {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  today.setDate(today.getDate() - 5);
  return today;
}

export const mockData: DashboardData = {
  user: 'Moran',
  sprint: {
    num: 42,
    startDate: sprintStartAnchor(),
    totalDays: 10,
  },
  syncedMinAgo: 2,
  pendingChanges: 2,
  running: [
    {
      id: '4530',
      title: 'Fix prod hotfix for login bug',
      story: 'Auth · Sprint 42',
      elapsedSec: 1 * 3600 + 12 * 60 + 4,
      estimateMin: 120,
      started: '11:47',
      focused: true,
    },
    {
      id: '4521',
      title: 'Refactor auth middleware',
      story: 'Auth · Sprint 42',
      elapsedSec: 1 * 3600 + 30 * 60,
      estimateMin: 240,
      started: '09:20',
    },
    {
      id: '4548',
      title: 'Investigate slow query on /reports',
      story: 'Performance · Sprint 42',
      elapsedSec: 22 * 60,
      estimateMin: 180,
      started: '13:25',
    },
  ],
  doneToday: [{ id: '4519', title: 'Login UI cleanup', effort: '2h' }],
  upNext: [
    { id: '4533', title: 'Add 2FA settings page', estimate: '3h' },
    { id: '4540', title: 'Email notification cleanup', estimate: '2h' },
  ],
};
