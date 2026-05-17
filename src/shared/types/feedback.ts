export interface AppRatingSummary {
  id: number;
  score: number;
  comment?: string | null;
  forgerResponse?: string | null;
  createdAt?: string;
  updatedAt?: string;
  user?: {
    firstName?: string;
    lastInitial?: string | null;
  };
}

export interface SubmitAppRatingInput {
  appId: string;
  score: number;
  comment?: string;
  locale?: string;
}

export interface SubmitProductFeedbackInput {
  target: 'forger' | 'app';
  appId?: string;
  kind: 'error' | 'confusing' | 'feature_request' | 'would_use_if' | 'would_not_use_because' | 'other';
  body: string;
  surface?: string;
  platform?: string;
  desktopVersion?: string;
  appVersionLabel?: string;
  locale?: string;
}
