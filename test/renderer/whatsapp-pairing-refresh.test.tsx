import { act, render, renderHook, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { WhatsAppPairingPanel } from '@renderer/views/connections/WhatsAppPairingPanel';
import { useWhatsAppPairing } from '@renderer/views/connections/useWhatsAppPairing';
const qr = (value: string, duration = 60_000) => ({ success: true, data: { status: 'qr_ready', qrDataUrl: value, expiresAt: new Date(Date.now() + duration).toISOString() } });
afterEach(() => vi.useRealTimers());
const setup = () => {
  vi.useFakeTimers();
  const start = vi.fn().mockResolvedValue(qr('first'));
  const poll = vi.fn().mockResolvedValue(qr('second'));
  Object.defineProperty(window, 'forger', { configurable: true, value: { connectionsCall: start, connectionsPairingStatus: poll } });
  const connected = vi.fn();
  const hook = renderHook(() => useWhatsAppPairing({ onConnected: connected, failureMessage: 'Try again' }));
  return { ...hook, start, poll, connected };
};
it('rotates the QR, stops on connection and does not restart pairing during reads', async () => {
  const { result, poll, start, connected } = setup();
  await act(async () => { await result.current.start('wa'); });
  expect(result.current.presentation).toMatchObject({ kind: 'qr', qrDataUrl: 'first' });
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(result.current.presentation).toMatchObject({ kind: 'qr', qrDataUrl: 'second' });
  poll.mockResolvedValue({ success: true, data: { status: 'connected' } });
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(connected).toHaveBeenCalledOnce();
  await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
  expect(poll).toHaveBeenCalledTimes(2);
  expect(start).toHaveBeenCalledOnce();
});
it('removes an expired QR while a read hangs; polls never overlap and retry recovers', async () => {
  const { result, poll, start } = setup();
  start.mockResolvedValue(qr('first', 4000));
  let finish!: (value: unknown) => void;
  poll.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  await act(async () => { await result.current.start('wa'); });
  await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
  expect(result.current.presentation.kind).toBe('expired');
  expect(poll).toHaveBeenCalledOnce();
  await act(async () => { finish({ success: false }); });
  expect(result.current.presentation.kind).toBe('error');
  start.mockResolvedValue(qr('retry'));
  await act(async () => { await result.current.retry(); });
  expect(result.current.presentation).toMatchObject({ kind: 'qr', qrDataUrl: 'retry' });
});
it('ignores late results after closing, reopening or unmounting', async () => {
  const { result, start, poll, unmount, connected } = setup();
  let finish!: (value: unknown) => void;
  start.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  let pending!: Promise<void>;
  act(() => { pending = result.current.start('old'); });
  act(() => result.current.stop());
  start.mockResolvedValue(qr('new'));
  await act(async () => { await result.current.start('new'); finish(qr('old')); await pending; });
  expect(result.current.presentation).toMatchObject({ qrDataUrl: 'new' });
  poll.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  unmount();
  await act(async () => { finish({ success: true, data: { status: 'connected' } }); });
  expect(connected).not.toHaveBeenCalled();
});

it('rejects missing, invalid and elapsed QR deadlines, and retry before an account exists is inert', async () => {
  const { result, start } = setup();
  await act(async () => { await result.current.retry(); });
  expect(start).not.toHaveBeenCalled();
  for (const expiresAt of [undefined, 'invalid', new Date(Date.now() - 1).toISOString()]) {
    start.mockResolvedValue({ success: true, data: { qrDataUrl: 'stale', expiresAt } });
    await act(async () => { await result.current.start('wa'); });
    expect(result.current.presentation.kind).toBe('expired');
  }
  start.mockResolvedValue({ success: true, data: {} });
  await act(async () => { await result.current.start('wa'); });
  expect(result.current.presentation.kind).toBe('waiting');
});

it('shows read failures and ignores rejected reads or starts belonging to closed dialogs', async () => {
  const { result, poll, start } = setup();
  poll.mockRejectedValueOnce(new Error('offline'));
  await act(async () => { await result.current.start('wa'); await vi.advanceTimersByTimeAsync(3000); });
  expect(result.current.presentation).toEqual({ kind: 'error', message: 'Try again' });
  let reject!: (error: Error) => void;
  poll.mockImplementation(() => new Promise((_resolve, rejectPromise) => { reject = rejectPromise; }));
  await act(async () => { await result.current.retry(); await vi.advanceTimersByTimeAsync(3000); });
  act(() => result.current.stop());
  await act(async () => { reject(new Error('late')); });
  expect(result.current.presentation.kind).toBe('idle');
  start.mockImplementation(() => new Promise((_resolve, rejectPromise) => { reject = rejectPromise; }));
  let pending!: Promise<void>;
  act(() => { pending = result.current.start('wa'); });
  act(() => result.current.stop());
  await act(async () => { reject(new Error('late start')); await pending; });
  expect(result.current.presentation.kind).toBe('idle');
});

it('does not schedule another read when the dialog closes between accepting a response and scheduling', async () => {
  const { result, start, poll } = setup();
  let finish!: (value: unknown) => void;
  start.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  let pending!: Promise<void>;
  act(() => { pending = result.current.start('wa'); });
  await act(async () => {
    finish(qr('ready'));
    queueMicrotask(() => result.current.stop());
    await pending;
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(poll).not.toHaveBeenCalled();
  expect(result.current.presentation.kind).toBe('idle');
});

it('ignores an expiry callback already queued when the dialog closes', async () => {
  const { result } = setup();
  const timer = vi.spyOn(globalThis, 'setTimeout');
  await act(async () => { await result.current.start('wa'); });
  const expire = timer.mock.calls.find(([, delay]) => delay === 60_000)?.[0] as (() => void);
  expect(expire).toBeTypeOf('function');
  act(() => { result.current.stop(); expire(); });
  expect(result.current.presentation.kind).toBe('idle');
  timer.mockRestore();
});

it('explains expiry and automatic refresh in Spanish with a visible recovery action', () => {
  const props = { waitingLabel: 'Espera', resultLabel: 'QR', locale: 'es', busy: false, onRetry: vi.fn() };
  const panel = render(<WhatsAppPairingPanel {...props} presentation={{ kind: 'expired' }} />);
  expect(screen.getByText('Este QR venció. Genera uno nuevo para vincular WhatsApp.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Generar un nuevo QR' })).toBeEnabled();
  panel.rerender(<WhatsAppPairingPanel {...props} presentation={{ kind: 'qr', qrDataUrl: 'qr' }} />);
  expect(screen.getByText(/El QR se actualiza automáticamente/)).toBeInTheDocument();
});
