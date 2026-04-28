import { alpha, createTheme } from '@mui/material/styles';

export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedThemeMode = 'light' | 'dark';

const lightPalette = {
  background: '#F8F9FB',
  surface: '#FFFFFF',
  border: '#E4E8EE',
  text: '#1F2328',
  muted: '#667085',
  primary: '#4B7BE8',
  copper: '#C46A3A',
  softCopper: '#F5E4DA',
  success: '#3A8F6A',
  warning: '#D99A2B',
  danger: '#C94A4A',
};

const darkPalette = {
  background: '#101418',
  surface: '#171C21',
  surfaceRaised: '#20262D',
  border: '#2D343C',
  text: '#F4F1EA',
  muted: '#A7B0BA',
  primary: '#7BA7D9',
  copper: '#E28A5A',
  softCopper: '#3A241B',
  success: '#66C092',
  warning: '#E5B454',
  danger: '#E06C75',
};

export const resolveThemeMode = (
  preference: ThemePreference,
  prefersDark: boolean,
): ResolvedThemeMode => {
  if (preference === 'system') {
    return prefersDark ? 'dark' : 'light';
  }

  return preference;
};

export const buildAppTheme = (mode: ResolvedThemeMode) => {
  const palette = mode === 'dark' ? darkPalette : lightPalette;
  const isDark = mode === 'dark';

  return createTheme({
    palette: {
      mode,
      primary: {
        main: palette.primary,
      },
      secondary: {
        main: palette.copper,
      },
      success: {
        main: palette.success,
      },
      warning: {
        main: palette.warning,
      },
      error: {
        main: palette.danger,
      },
      background: {
        default: palette.background,
        paper: palette.surface,
      },
      text: {
        primary: palette.text,
        secondary: palette.muted,
      },
      divider: palette.border,
    },
    shape: {
      borderRadius: 10,
    },
    typography: {
      fontFamily: '"Fraunces", "IBM Plex Sans", "Segoe UI", sans-serif',
      h4: {
        fontWeight: 700,
        letterSpacing: '-0.03em',
      },
      h5: {
        fontWeight: 700,
        letterSpacing: '-0.025em',
      },
      h6: {
        fontWeight: 700,
        letterSpacing: '-0.02em',
      },
      subtitle1: {
        fontFamily: '"IBM Plex Sans", "Segoe UI", sans-serif',
        fontWeight: 600,
      },
      subtitle2: {
        fontFamily: '"IBM Plex Sans", "Segoe UI", sans-serif',
        fontWeight: 600,
      },
      body1: {
        fontFamily: '"IBM Plex Sans", "Segoe UI", sans-serif',
        lineHeight: 1.55,
      },
      body2: {
        fontFamily: '"IBM Plex Sans", "Segoe UI", sans-serif',
        lineHeight: 1.5,
      },
      button: {
        fontFamily: '"IBM Plex Sans", "Segoe UI", sans-serif',
        fontWeight: 600,
        textTransform: 'none',
      },
      caption: {
        fontFamily: '"IBM Plex Sans", "Segoe UI", sans-serif',
      },
    },
    components: {
      MuiCssBaseline: {
        styleOverrides: {
          'html, body, #root': {
            width: '100%',
            height: '100%',
            overflow: 'hidden',
          },
          '*': {
            scrollbarWidth: 'thin',
            scrollbarColor: `${alpha(palette.muted, isDark ? 0.72 : 0.46)} transparent`,
          },
          '*::-webkit-scrollbar': {
            width: 12,
            height: 12,
          },
          '*::-webkit-scrollbar-track': {
            backgroundColor: 'transparent',
          },
          '*::-webkit-scrollbar-thumb': {
            minHeight: 36,
            borderRadius: 999,
            border: '3px solid transparent',
            backgroundClip: 'content-box',
            backgroundColor: alpha(palette.muted, isDark ? 0.58 : 0.34),
          },
          '*::-webkit-scrollbar-thumb:hover': {
            backgroundColor: alpha(palette.muted, isDark ? 0.78 : 0.54),
          },
          '*::-webkit-scrollbar-corner': {
            backgroundColor: 'transparent',
          },
          body: {
            backgroundColor: palette.background,
            backgroundImage: isDark
              ? `radial-gradient(circle at top left, ${alpha(palette.primary, 0.18)}, transparent 28%), radial-gradient(circle at 85% 15%, ${alpha(palette.copper, 0.16)}, transparent 22%)`
              : `radial-gradient(circle at top left, ${alpha(palette.primary, 0.08)}, transparent 28%), radial-gradient(circle at 85% 15%, ${alpha(palette.copper, 0.12)}, transparent 20%)`,
          },
        },
      },
      MuiCard: {
        styleOverrides: {
          root: {
            backgroundColor: palette.surface,
            border: `1px solid ${palette.border}`,
            boxShadow: isDark
              ? '0 20px 40px rgba(0, 0, 0, 0.24)'
              : '0 18px 36px rgba(70, 53, 31, 0.08)',
          },
        },
      },
      MuiPaper: {
        styleOverrides: {
          root: {
            backgroundImage: 'none',
          },
        },
      },
      MuiButton: {
        styleOverrides: {
          root: {
            paddingInline: 16,
            minHeight: 40,
          },
          containedPrimary: {
            boxShadow: 'none',
          },
        },
      },
      MuiChip: {
        styleOverrides: {
          root: {
            fontWeight: 600,
          },
        },
      },
      MuiListItemButton: {
        styleOverrides: {
          root: {
            borderRadius: 10,
            minHeight: 46,
          },
        },
      },
      MuiTextField: {
        defaultProps: {
          variant: 'outlined',
        },
      },
      MuiOutlinedInput: {
        styleOverrides: {
          root: {},
        },
      },
    },
  });
};
