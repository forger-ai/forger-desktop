---
name: forger-mui-date-pickers
description: Use this when creating or changing date, time, date-range, calendar, schedule, due-date, reporting-period, or temporal filter inputs in Forger React/MUI apps.
---

## Package Boundary

- Use MUI X Community Date and Time Pickers from `@mui/x-date-pickers`.
- Do not use MUI X Pro or Premium date picker features unless the app explicitly has a paid license and the user asks for them.
- Before using pickers, verify the app has `@mui/x-date-pickers` and the required date adapter dependency.
- Wrap picker usage in `LocalizationProvider` with the app's chosen date adapter.

## Component Choice

- Use `DatePicker` when the person benefits from both typed input and a calendar popover.
- Use `TimePicker` when choosing a time benefits from a picker UI.
- Use `DateTimePicker` when date and time are edited together and saved as one value.
- Use `DateField`, `TimeField`, or `DateTimeField` when keyboard-first entry is enough and a picker popover would add noise.
- Use separate start and end `DatePicker` fields for free date-range needs unless a licensed range picker is explicitly available.
- Do not use `TextField type="date"` when the expected behavior is a MUI-styled calendar picker. `type="date"` opens the browser or operating-system native date picker and varies by platform.
- Use native `type="date"` only when the app intentionally wants a basic platform-native date input and the inconsistent picker UI is acceptable.

## Data And Validation

- Keep durable date values typed and normalized at the app boundary. Do not store localized display strings as durable data.
- Choose and document the semantic value: date-only, local date-time, UTC timestamp, month, year, or reporting period.
- Show validation through picker props and field helper text: required, invalid date, min date, max date, disabled future or past dates, unavailable dates, and incomplete ranges.
- If timezone affects meaning, state it in the UI or normalize it before persistence. Do not silently mix local dates and UTC timestamps.
- For date ranges, validate both ends together: start required, end required, start before or equal end, and clear behavior for open-ended ranges.
- Use clear empty states and reset actions when filters can be cleared.

## UX Patterns

- Prefer one date input per concept. Do not combine due date, reminder date, reporting date, and created date into one ambiguous control.
- Use labels that describe the business meaning: `Due date`, `Payment date`, `Report start`, `Report end`, `Scheduled for`.
- Use helper text for allowed ranges, timezone assumptions, and whether the value is optional.
- Use responsive picker behavior when the same flow must work on desktop and touch devices.
- Keep picker dialogs/popovers inside the current task flow. Do not hide important save/cancel actions behind the picker.
- For recurring schedules, combine date/time pickers with explicit recurrence controls instead of encoding recurrence in one text field.
- For month or year reporting filters, use the picker view that matches the reporting unit rather than asking for an arbitrary day.

## Implementation Checks

- Clicking a MUI date input opens the MUI picker UI, not the native browser date picker, unless native behavior was intentionally chosen.
- Keyboard entry, paste, invalid values, clearing, disabled dates, min/max limits, and form submission all behave predictably.
- Stored values remain stable across reloads, locale changes, and timezone boundaries.
- Mobile and desktop layouts keep labels, helper text, validation errors, and picker popovers/dialogs readable.
