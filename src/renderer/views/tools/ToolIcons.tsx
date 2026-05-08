import { Box } from '@mui/material';
import iconDark from '@renderer/assets/icon-dark.svg';
import iconLight from '@renderer/assets/icon-light.svg';

export const ForgerToolIcon = ({ mode, size = 44 }: { mode: 'light' | 'dark'; size?: number }) => (
  <Box
    component="img"
    src={mode === 'dark' ? iconDark : iconLight}
    alt=""
    sx={{ width: size, height: size, flexShrink: 0 }}
  />
);

export const GmailIcon = () => (
  <Box
    aria-hidden
    sx={{
      width: 44,
      height: 44,
      display: 'grid',
      placeItems: 'center',
      flexShrink: 0,
    }}
  >
    <svg viewBox="0 0 256 193" width="40" height="31" role="img" aria-label="Gmail">
      <path fill="#4285F4" d="M58.182 192.05V93.14L26.98 69.78 0 49.523v125.095c0 9.612 7.82 17.432 17.432 17.432h40.75Z" />
      <path fill="#34A853" d="M197.818 192.05h40.75c9.612 0 17.432-7.82 17.432-17.432V49.523l-31.125 23.35-27.057 20.267v98.91Z" />
      <path fill="#EA4335" d="M58.182 93.14 53.93 54.2l4.252-37.297L128 69.779l69.818-52.876 4.667 35.254-4.667 40.984L128 145.958 58.182 93.141Z" />
      <path fill="#FBBC04" d="M197.818 16.903V93.14L256 49.523V25.62c0-21.485-24.53-33.74-41.71-20.85l-16.472 12.133Z" />
      <path fill="#C5221F" d="M0 49.523 26.98 69.78 58.182 93.14V16.903L41.71 4.77C24.53-8.12 0 4.135 0 25.62v23.903Z" />
    </svg>
  </Box>
);
