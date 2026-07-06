import { Box } from '@mui/material';
import {
  siCalendly,
  siDiscord,
  siFigma,
  siGit,
  siGithub,
  siGitlab,
  siGooglecalendar,
  siGoogledocs,
  siGoogledrive,
  siGooglesheets,
  siMeta,
  siNotion,
  siShopify,
  siTelegram,
  siWhatsapp,
  siZendesk,
  type SimpleIcon,
} from 'simple-icons';

const icons: Record<string, SimpleIcon> = {
  calendar: siGooglecalendar,
  sheets: siGooglesheets,
  drive: siGoogledrive,
  docs: siGoogledocs,
  github: siGithub,
  notion: siNotion,
  figma: siFigma,
  zendesk: siZendesk,
  discord: siDiscord,
  calendly: siCalendly,
  gitlab: siGitlab,
  shopify: siShopify,
  whatsapp_business: siWhatsapp,
  telegram: siTelegram,
  meta_ads: siMeta,
};

const fallback: Record<string, { fill: string; text: string }> = {
  sendgrid: { fill: '#1A82E2', text: 'SG' },
  postmark: { fill: '#FFDE00', text: 'PM' },
  twilio: { fill: '#F22F46', text: 'TW' },
};

export const BrandIcon = ({ type, size = 44 }: { type: string; size?: number }) => {
  const icon = icons[type] ?? (type === 'git' ? siGit : undefined);
  if (icon) {
    return (
      <Box aria-hidden sx={{ width: size, height: size, display: 'grid', placeItems: 'center', flexShrink: 0 }}>
        <svg viewBox="0 0 24 24" width={Math.round(size * 0.78)} height={Math.round(size * 0.78)} role="img" aria-label={icon.title}>
          <path fill={`#${icon.hex}`} d={icon.path} />
        </svg>
      </Box>
    );
  }
  const local = fallback[type] ?? { fill: '#5C6BC0', text: type.slice(0, 2).toUpperCase() };
  return (
    <Box aria-hidden sx={{ width: size, height: size, display: 'grid', placeItems: 'center', flexShrink: 0 }}>
      <svg viewBox="0 0 44 44" width={size} height={size} role="img" aria-label={type}>
        <rect x="4" y="4" width="36" height="36" rx="8" fill={local.fill} />
        <text x="22" y="27" textAnchor="middle" fontFamily="Arial, sans-serif" fontSize="12" fontWeight="700" fill={type === 'postmark' ? '#111111' : '#ffffff'}>{local.text}</text>
      </svg>
    </Box>
  );
};
