import type { AppAgent, AppPromptTemplate } from './prompts';
import type { AppCapability, AppSummary } from './catalog';
import type { AppRatingSummary } from './feedback';

export interface CatalogApp extends AppSummary {
  latestVersionId?: number;
  latestVersion?: string;
  requiredPythonVersion?: string;
  requiredNodeVersion?: string;
  checksumSha256?: string;
  downloadUrl?: string;
  capabilities?: AppCapability[];
  averageRating?: number;
  ratingsCount?: number;
  recentRatings?: AppRatingSummary[];
  currentUserRating?: AppRatingSummary;
  promptTemplates?: AppPromptTemplate[];
  agents?: AppAgent[];
}
