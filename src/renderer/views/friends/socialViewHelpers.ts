import type { Dispatch, SetStateAction } from 'react';
import type { CloudFriendship } from '@shared/types';

export type SocialTab = 'friends' | 'requests' | 'apps' | 'forum' | 'add';

export const LAST_SOCIAL_TAB_KEY = 'forger.social.last-tab';

export const friendLabel = (friendship: CloudFriendship) =>
  friendship.friend.firstName || friendship.friend.username;

export const requestLabel = (friendship: CloudFriendship) =>
  friendship.friend.firstName || `@${friendship.friend.username}`;

export const isFriendOnline = (friendship: CloudFriendship) =>
  Boolean(friendship.friend.online);

export const activityTimestamp = (friendship: CloudFriendship) =>
  friendship.lastMessageAt ?? friendship.updatedAt;

export const formatRelativeActivity = (value?: string) => {
  if (!value) {
    return 'Sin actividad reciente';
  }

  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) {
    return 'Actividad reciente';
  }

  const diffMinutes = Math.max(0, Math.round((Date.now() - timestamp) / 60000));
  if (diffMinutes < 2) {
    return 'Activo ahora';
  }
  if (diffMinutes < 60) {
    return `Activo hace ${diffMinutes} min`;
  }

  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) {
    return `Activo hace ${diffHours} h`;
  }

  const diffDays = Math.round(diffHours / 24);
  return `Activo hace ${diffDays} d`;
};

export const sortFriends = (entries: CloudFriendship[]) =>
  [...entries].sort((left, right) => {
    const leftOnline = isFriendOnline(left) ? 1 : 0;
    const rightOnline = isFriendOnline(right) ? 1 : 0;
    if (leftOnline !== rightOnline) {
      return rightOnline - leftOnline;
    }

    const leftUpdated = new Date(activityTimestamp(left)).getTime();
    const rightUpdated = new Date(activityTimestamp(right)).getTime();
    if (leftUpdated !== rightUpdated) {
      return rightUpdated - leftUpdated;
    }

    return friendLabel(left).localeCompare(friendLabel(right), 'es', { sensitivity: 'base' });
  });

export const readLastSessionTab = (): SocialTab | null => {
  if (typeof window === 'undefined') {
    return null;
  }

  const value = window.sessionStorage.getItem(LAST_SOCIAL_TAB_KEY);
  return value === 'requests' || value === 'apps' || value === 'forum' || value === 'add' ? value : 'friends';
};

export const setTimedFeedback = (
  setter: Dispatch<SetStateAction<Record<number, string>>>,
  key: number,
  message: string,
) => {
  setter((current) => ({ ...current, [key]: message }));
  window.setTimeout(() => {
    setter((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
  }, 2200);
};
