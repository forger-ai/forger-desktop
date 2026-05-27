import AddBoxRounded from '@mui/icons-material/AddBoxRounded';
import AutoAwesomeRounded from '@mui/icons-material/AutoAwesomeRounded';
import {
  Box,
  Button,
  FormControl,
  FormControlLabel,
  FormLabel,
  LinearProgress,
  Radio,
  RadioGroup,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { useState } from 'react';
import type { AppDictionary } from '@renderer/i18n';

interface CreateViewProps {
  t: AppDictionary;
  busy: boolean;
  onCreate: (input: { name: string; description: string; purpose: string; lookAndFeel?: string }) => Promise<void>;
}

export function CreateView({ t, busy, onCreate }: CreateViewProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [purpose, setPurpose] = useState('');
  const [lookAndFeel, setLookAndFeel] = useState('minimalist');
  const [paletteMode, setPaletteMode] = useState<'auto' | 'custom'>('auto');
  const [backgroundColor, setBackgroundColor] = useState('#f8fafc');
  const [accentColor, setAccentColor] = useState('#2563eb');
  const [secondaryColor, setSecondaryColor] = useState('#14b8a6');
  const [error, setError] = useState<string | null>(null);
  const labels = t.sections.create;

  const lookAndFeelOptions = labels.lookAndFeelOptions();
  const selectedLookAndFeel = lookAndFeelOptions.find((option) => option.id === lookAndFeel);
  const canSubmit = Boolean(name.trim() && description.trim() && purpose.trim() && selectedLookAndFeel) && !busy;

  const colorFields = [
    {
      key: 'background',
      label: labels.paletteBackgroundLabel,
      value: backgroundColor,
      onChange: setBackgroundColor,
    },
    {
      key: 'accent',
      label: labels.paletteAccentLabel,
      value: accentColor,
      onChange: setAccentColor,
    },
    {
      key: 'secondary',
      label: labels.paletteSecondaryLabel,
      value: secondaryColor,
      onChange: setSecondaryColor,
    },
  ];

  const randomizePalette = () => {
    const palettes = [
      ['#f8fafc', '#2563eb', '#14b8a6'],
      ['#fff7ed', '#c2410c', '#0f766e'],
      ['#f5f3ff', '#7c3aed', '#db2777'],
      ['#f7fee7', '#4d7c0f', '#0891b2'],
      ['#fdf2f8', '#be185d', '#0d9488'],
      ['#f1f5f9', '#334155', '#d97706'],
      ['#ecfeff', '#0891b2', '#7c2d12'],
    ];
    const current = `${backgroundColor}-${accentColor}-${secondaryColor}`;
    const candidates = palettes.filter((palette) => palette.join('-') !== current);
    const [nextBackground, nextAccent, nextSecondary] = candidates[Math.floor(Math.random() * candidates.length)] ?? palettes[0];
    setPaletteMode('custom');
    setBackgroundColor(nextBackground);
    setAccentColor(nextAccent);
    setSecondaryColor(nextSecondary);
  };

  const buildLookAndFeelPrompt = () => {
    if (!selectedLookAndFeel) return undefined;
    const palettePrompt = paletteMode === 'auto'
      ? labels.paletteAutoPrompt
      : labels.paletteCustomPrompt({
          background: backgroundColor,
          accent: accentColor,
          secondary: secondaryColor,
        });
    return `${selectedLookAndFeel.title}: ${selectedLookAndFeel.description}\nPalette: ${palettePrompt}`;
  };

  const handleSubmit = async () => {
    if (!canSubmit) {
      setError(labels.missingFields);
      return;
    }
    setError(null);
    await onCreate({
      name: name.trim(),
      description: description.trim(),
      purpose: purpose.trim(),
      lookAndFeel: buildLookAndFeelPrompt(),
    });
  };

  return (
    <Stack spacing={3} sx={{ maxWidth: 860 }}>
      <Stack spacing={0.75}>
        <Typography variant="h4" fontWeight={800}>
          {labels.title}
        </Typography>
        <Typography color="text.secondary" sx={{ maxWidth: 680 }}>
          {labels.subtitle}
        </Typography>
      </Stack>

      <Box
        sx={{
          border: '1px solid',
          borderColor: 'divider',
          bgcolor: 'background.paper',
          p: 2.5,
          borderRadius: 1,
        }}
      >
        <Stack spacing={2}>
          {busy ? <LinearProgress /> : null}
          <TextField
            label={labels.nameLabel}
            placeholder={labels.namePlaceholder}
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={busy}
            inputProps={{ maxLength: 80 }}
            fullWidth
          />
          <TextField
            label={labels.descriptionLabel}
            placeholder={labels.descriptionPlaceholder}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            disabled={busy}
            inputProps={{ maxLength: 180 }}
            fullWidth
          />
          <TextField
            label={labels.purposeLabel}
            placeholder={labels.purposePlaceholder}
            value={purpose}
            onChange={(event) => setPurpose(event.target.value)}
            disabled={busy}
            minRows={6}
            multiline
            fullWidth
          />
          <FormControl disabled={busy}>
            <FormLabel sx={{ mb: 1, color: 'text.primary', fontWeight: 800 }}>
              {labels.lookAndFeelLabel}
            </FormLabel>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5, maxWidth: 680 }}>
              {labels.lookAndFeelHelper}
            </Typography>
            <RadioGroup
              value={lookAndFeel}
              onChange={(event) => setLookAndFeel(event.target.value)}
              sx={{
                display: 'grid',
                gap: 1.25,
                gridTemplateColumns: { xs: '1fr', sm: 'repeat(3, minmax(0, 1fr))' },
              }}
            >
              {lookAndFeelOptions.map((option) => (
                <Box
                  key={option.id}
                  component="button"
                  type="button"
                  disabled={busy}
                  onClick={() => setLookAndFeel(option.id)}
                  sx={{
                    border: '1px solid',
                    borderColor: lookAndFeel === option.id ? 'primary.main' : 'divider',
                    bgcolor: lookAndFeel === option.id ? 'action.selected' : 'background.default',
                    borderRadius: 1,
                    color: 'text.primary',
                    cursor: busy ? 'default' : 'pointer',
                    font: 'inherit',
                    minHeight: 138,
                    p: 1.5,
                    textAlign: 'left',
                    width: '100%',
                    '&:hover': {
                      borderColor: busy ? undefined : 'primary.main',
                      bgcolor: busy ? undefined : 'action.hover',
                    },
                  }}
                >
                  <Stack spacing={1} sx={{ height: '100%' }}>
                    <Stack direction="row" spacing={1} alignItems="center">
                      <Radio checked={lookAndFeel === option.id} value={option.id} sx={{ p: 0 }} />
                      <Typography fontWeight={800}>{option.title}</Typography>
                    </Stack>
                    <Typography variant="body2" color="text.secondary">
                      {option.description}
                    </Typography>
                  </Stack>
                </Box>
              ))}
            </RadioGroup>
          </FormControl>
          <FormControl disabled={busy}>
            <FormLabel sx={{ mb: 1, color: 'text.primary', fontWeight: 800 }}>
              {labels.paletteLabel}
            </FormLabel>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5, maxWidth: 680 }}>
              {labels.paletteHelper}
            </Typography>
            <RadioGroup
              value={paletteMode}
              onChange={(event) => setPaletteMode(event.target.value as 'auto' | 'custom')}
              sx={{ display: 'grid', gap: 1.25 }}
            >
              <Box
                sx={{
                  border: '1px solid',
                  borderColor: paletteMode === 'auto' ? 'primary.main' : 'divider',
                  bgcolor: paletteMode === 'auto' ? 'action.selected' : 'background.default',
                  borderRadius: 1,
                  px: 1.5,
                  py: 1,
                }}
              >
                <FormControlLabel
                  value="auto"
                  control={<Radio />}
                  label={(
                    <Stack spacing={0.35}>
                      <Typography fontWeight={800}>{labels.paletteAutoLabel}</Typography>
                      <Typography variant="body2" color="text.secondary">
                        {labels.paletteAutoHelper}
                      </Typography>
                    </Stack>
                  )}
                  sx={{
                    alignItems: 'flex-start',
                    m: 0,
                    width: '100%',
                    '.MuiFormControlLabel-label': { width: '100%' },
                  }}
                />
              </Box>
              <Box
                sx={{
                  border: '1px solid',
                  borderColor: paletteMode === 'custom' ? 'primary.main' : 'divider',
                  bgcolor: paletteMode === 'custom' ? 'action.selected' : 'background.default',
                  borderRadius: 1,
                  p: 1.5,
                }}
              >
                <FormControlLabel
                  value="custom"
                  control={<Radio />}
                  label={(
                    <Stack spacing={1.25}>
                      <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between" flexWrap="wrap">
                        <Typography fontWeight={800}>{labels.paletteCustomLabel}</Typography>
                        <Button
                          size="small"
                          variant="outlined"
                          startIcon={<AutoAwesomeRounded />}
                          disabled={busy}
                          onClick={(event) => {
                            event.preventDefault();
                            randomizePalette();
                          }}
                        >
                          {labels.paletteRandomize}
                        </Button>
                      </Stack>
                      <Box
                        sx={{
                          display: 'grid',
                          gap: 1,
                          gridTemplateColumns: { xs: '1fr', sm: 'repeat(3, minmax(0, 1fr))' },
                        }}
                      >
                        {colorFields.map((field) => (
                          <TextField
                            key={field.key}
                            label={field.label}
                            type="color"
                            value={field.value}
                            disabled={busy}
                            onChange={(event) => {
                              setPaletteMode('custom');
                              field.onChange(event.target.value);
                            }}
                            InputLabelProps={{ shrink: true }}
                            inputProps={{ sx: { height: 42, p: 0.75, cursor: 'pointer' } }}
                            fullWidth
                          />
                        ))}
                      </Box>
                    </Stack>
                  )}
                  sx={{
                    alignItems: 'flex-start',
                    m: 0,
                    width: '100%',
                    '.MuiFormControlLabel-label': { width: '100%' },
                  }}
                />
              </Box>
            </RadioGroup>
          </FormControl>
          {error ? <Typography color="error">{error}</Typography> : null}
          <Button
            variant="contained"
            startIcon={<AddBoxRounded />}
            disabled={!canSubmit}
            onClick={() => void handleSubmit()}
            sx={{ alignSelf: 'flex-start' }}
          >
            {busy ? labels.creating : labels.submit}
          </Button>
        </Stack>
      </Box>
    </Stack>
  );
}
