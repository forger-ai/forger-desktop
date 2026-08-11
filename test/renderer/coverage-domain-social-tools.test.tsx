import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Dispatch, SetStateAction } from 'react';
import type { AgentToolDefinition, AgentToolPackageDefinition, CloudFriendship } from '@shared/types';
import { getDictionary } from '@renderer/i18n';
import {
  LAST_SOCIAL_TAB_KEY,
  activityTimestamp,
  formatRelativeActivity,
  friendLabel,
  isFriendOnline,
  readLastSessionTab,
  requestLabel,
  setTimedFeedback,
  sortFriends,
} from '@renderer/views/friends/socialViewHelpers';
import { BrandIcon } from '@renderer/views/tools/BrandIcons';
import { FORGER_PACKAGE_ID, officialToolPackageId } from '@renderer/views/tools/constants';
import {
  ForgerToolIcon,
  GmailIcon,
  SlackIcon,
  TrelloIcon,
} from '@renderer/views/tools/ToolIcons';
import {
  localizedPackageCopy,
  localizedToolCopy,
  requiresApproval,
  riskColor,
} from '@renderer/views/tools/tool-helpers';

const friendship = (
  id: number,
  values: {
    firstName?: string;
    lastMessageAt?: string | null;
    online?: boolean;
    updatedAt?: string;
    username?: string;
  } = {},
): CloudFriendship => ({
  id,
  status: 'accepted',
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: values.updatedAt ?? '2026-08-01T00:00:00.000Z',
  lastMessageAt: values.lastMessageAt,
  friend: {
    id,
    username: values.username ?? `friend-${id}`,
    firstName: values.firstName,
    online: values.online,
  },
} as CloudFriendship);

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.sessionStorage.clear();
});

describe('social view helpers', () => {
  it('builds labels and current activity from the available friendship fields', () => {
    const named = friendship(1, { firstName: 'Ana', username: 'ana', online: true, lastMessageAt: '2026-08-10T10:00:00.000Z' });
    const unnamed = friendship(2, { username: 'bob', online: false, updatedAt: '2026-08-09T10:00:00.000Z' });
    expect(friendLabel(named)).toBe('Ana');
    expect(friendLabel(unnamed)).toBe('bob');
    expect(requestLabel(named)).toBe('Ana');
    expect(requestLabel(unnamed)).toBe('@bob');
    expect(isFriendOnline(named)).toBe(true);
    expect(isFriendOnline(unnamed)).toBe(false);
    expect(activityTimestamp(named)).toBe('2026-08-10T10:00:00.000Z');
    expect(activityTimestamp(unnamed)).toBe('2026-08-09T10:00:00.000Z');
  });

  it('formats every relative activity band and contains invalid or future dates', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-10T12:00:00.000Z'));
    expect(formatRelativeActivity()).toBe('Sin actividad reciente');
    expect(formatRelativeActivity('invalid')).toBe('Actividad reciente');
    expect(formatRelativeActivity('2026-08-10T12:10:00.000Z')).toBe('Activo ahora');
    expect(formatRelativeActivity('2026-08-10T11:59:00.000Z')).toBe('Activo ahora');
    expect(formatRelativeActivity('2026-08-10T11:30:00.000Z')).toBe('Activo hace 30 min');
    expect(formatRelativeActivity('2026-08-10T10:00:00.000Z')).toBe('Activo hace 2 h');
    expect(formatRelativeActivity('2026-08-08T12:00:00.000Z')).toBe('Activo hace 2 d');
  });

  it('sorts friends by online state, recent activity, and localized label', () => {
    const entries = [
      friendship(1, { firstName: 'Zulu', online: false, updatedAt: '2026-08-10T12:00:00.000Z' }),
      friendship(2, { firstName: 'Álvaro', online: true, updatedAt: '2026-08-10T10:00:00.000Z' }),
      friendship(3, { firstName: 'Bea', online: true, updatedAt: '2026-08-10T11:00:00.000Z' }),
      friendship(4, { firstName: 'Ana', online: true, updatedAt: '2026-08-10T10:00:00.000Z' }),
    ];
    expect(sortFriends(entries).map((item) => item.id)).toEqual([3, 2, 4, 1]);
    expect(entries.map((item) => item.id)).toEqual([1, 2, 3, 4]);
    expect(sortFriends([
      friendship(5, { firstName: 'Zulu', online: false, updatedAt: '2026-08-10T10:00:00.000Z' }),
      friendship(6, { firstName: 'Alpha', online: false, updatedAt: '2026-08-10T10:00:00.000Z' }),
    ]).map((item) => item.id)).toEqual([6, 5]);
  });

  it('restores each supported session tab and defaults invalid values to friends', () => {
    expect(readLastSessionTab()).toBe('friends');
    for (const tab of ['requests', 'apps', 'forum', 'add', 'profile', 'search'] as const) {
      sessionStorage.setItem(LAST_SOCIAL_TAB_KEY, tab);
      expect(readLastSessionTab()).toBe(tab);
    }
    sessionStorage.setItem(LAST_SOCIAL_TAB_KEY, 'invalid');
    expect(readLastSessionTab()).toBe('friends');
    vi.stubGlobal('window', undefined);
    expect(readLastSessionTab()).toBeNull();
  });

  it('sets feedback immediately and removes only its key after the timeout', () => {
    vi.useFakeTimers();
    let state: Record<number, string> = { 2: 'keep' };
    const setter: Dispatch<SetStateAction<Record<number, string>>> = vi.fn((update) => {
      state = typeof update === 'function' ? update(state) : update;
    });
    setTimedFeedback(setter, 1, 'Copied');
    expect(state).toEqual({ 1: 'Copied', 2: 'keep' });
    act(() => vi.advanceTimersByTime(2199));
    expect(state).toEqual({ 1: 'Copied', 2: 'keep' });
    act(() => vi.advanceTimersByTime(1));
    expect(state).toEqual({ 2: 'keep' });
    expect(setter).toHaveBeenCalledTimes(2);
  });
});

describe('tool identity components', () => {
  it('builds stable package identifiers', () => {
    expect(FORGER_PACKAGE_ID).toBe('forger');
    expect(officialToolPackageId('gmail')).toBe('official:gmail');
  });

  it('maps risks, approvals, and localized or package-owned copy', () => {
    const t = getDictionary('en');
    const tool: AgentToolDefinition = {
      id: 'forger_list_catalog',
      packageId: 'forger',
      name: 'Fallback tool',
      description: 'Fallback description',
      category: 'consulta',
      risk: 'bajo',
      defaultRequiresApproval: true,
    };
    const toolPackage: AgentToolPackageDefinition = {
      id: 'forger',
      name: 'Fallback package',
      description: 'Fallback package description',
      icon: 'forger',
      tools: [tool],
    };
    expect(riskColor('alto')).toBe('error');
    expect(riskColor('medio')).toBe('warning');
    expect(riskColor('bajo')).toBe('success');
    expect(requiresApproval({}, tool)).toBe(true);
    expect(requiresApproval({ [tool.id]: false }, tool)).toBe(false);
    expect(requiresApproval({ [tool.id]: true }, { ...tool, defaultRequiresApproval: false })).toBe(true);
    expect(localizedPackageCopy(t, toolPackage)).toEqual(t.sections.tools.packages.forger);
    expect(localizedToolCopy(t, tool)).toEqual(t.sections.tools.definitions.forger_list_catalog);

    const customTool = { ...tool, id: 'forger_app_list' as const, name: 'Custom tool', description: 'Custom description' };
    const customPackage = { ...toolPackage, id: 'custom', name: 'Custom package', description: 'Custom package description' };
    expect(localizedPackageCopy(t, customPackage)).toEqual({ name: 'Custom package', description: 'Custom package description' });
    expect(localizedToolCopy({
      ...t,
      sections: { ...t.sections, tools: { ...t.sections.tools, definitions: {} } },
    }, customTool)).toEqual({ name: 'Custom tool', description: 'Custom description' });
  });

  it('renders official, git, local fallback, and generated fallback brand icons', () => {
    const github = render(<BrandIcon type="github" />).container;
    expect(github.querySelector('svg')).toHaveAttribute('aria-label', 'GitHub');
    expect(github.querySelector('svg')).toHaveAttribute('width', '34');
    expect(github.querySelector('path')).toHaveAttribute('fill', expect.stringMatching(/^#/));

    const git = render(<BrandIcon type="git" size={50} />).container;
    expect(git.querySelector('svg')).toHaveAttribute('aria-label', 'Git');
    expect(git.querySelector('svg')).toHaveAttribute('width', '39');

    const sendgrid = render(<BrandIcon type="sendgrid" />).container;
    expect(sendgrid.querySelector('text')).toHaveTextContent('SG');
    expect(sendgrid.querySelector('text')).toHaveAttribute('fill', '#ffffff');

    const postmark = render(<BrandIcon type="postmark" />).container;
    expect(postmark.querySelector('text')).toHaveTextContent('PM');
    expect(postmark.querySelector('text')).toHaveAttribute('fill', '#111111');

    const custom = render(<BrandIcon type="custom-service" />).container;
    expect(custom.querySelector('text')).toHaveTextContent('CU');
    expect(custom.querySelector('rect')).toHaveAttribute('fill', '#5C6BC0');
  });

  it('switches the Forger asset by mode and renders all custom connection glyphs', () => {
    const light = render(<ForgerToolIcon mode="light" size={30} />).container;
    const dark = render(<ForgerToolIcon mode="dark" />).container;
    const lightSource = light.querySelector('img')?.getAttribute('src');
    const darkSource = dark.querySelector('img')?.getAttribute('src');
    expect(lightSource).toMatch(/^data:image\/svg\+xml/);
    expect(darkSource).toMatch(/^data:image\/svg\+xml/);
    expect(lightSource).not.toBe(darkSource);

    const gmail = render(<GmailIcon />).container;
    const slack = render(<SlackIcon />).container;
    const trello = render(<TrelloIcon />).container;
    expect(gmail.querySelector('svg')).toHaveAttribute('aria-label', 'Gmail');
    expect(slack.querySelector('svg')).toHaveAttribute('aria-label', 'Slack');
    expect(trello.querySelector('svg')).toHaveAttribute('aria-label', 'Trello');
  });
});
