import AddBoxRounded from '@mui/icons-material/AddBoxRounded';
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
  const [lookAndFeel, setLookAndFeel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const labels = t.sections.create;

  const lookAndFeelOptions = labels.lookAndFeelOptions({
    name: name.trim() || labels.nameFallback,
    purpose: purpose.trim() || labels.purposeFallback,
  });
  const selectedLookAndFeel = lookAndFeelOptions.find((option) => option.id === lookAndFeel);
  const canSubmit = Boolean(name.trim() && description.trim() && purpose.trim() && selectedLookAndFeel) && !busy;

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
      lookAndFeel: selectedLookAndFeel
        ? `${selectedLookAndFeel.title}: ${selectedLookAndFeel.description}`
        : undefined,
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
              sx={{ display: 'grid', gap: 1.25 }}
            >
              {lookAndFeelOptions.map((option) => (
                <Box
                  key={option.id}
                  sx={{
                    border: '1px solid',
                    borderColor: lookAndFeel === option.id ? 'primary.main' : 'divider',
                    bgcolor: lookAndFeel === option.id ? 'action.selected' : 'background.default',
                    borderRadius: 1,
                    px: 1.5,
                    py: 1,
                  }}
                >
                  <FormControlLabel
                    value={option.id}
                    control={<Radio />}
                    label={(
                      <Stack spacing={0.35}>
                        <Typography fontWeight={800}>{option.title}</Typography>
                        <Typography variant="body2" color="text.secondary">
                          {option.description}
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
              ))}
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
