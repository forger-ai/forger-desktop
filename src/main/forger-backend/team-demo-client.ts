import type { TeamDemoRequestInput, TeamDemoRequestResult } from '../../shared/types';
interface TeamDemoClientOptions {
  backendBaseUrl: string;
}

const readJsonObject = async (response: Response): Promise<Record<string, unknown> | null> => {
  const raw = await response.text();
  if (!raw) return null;
  try {
    const payload: unknown = JSON.parse(raw);
    return payload && typeof payload === 'object' && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
};

export class TeamDemoClient {
  constructor(private readonly options: TeamDemoClientOptions) {}

  async request(input: TeamDemoRequestInput): Promise<TeamDemoRequestResult> {
    const response = await fetch(`${this.options.backendBaseUrl}/api/team_demo_requests`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contact_name: input.name,
        email: input.email,
        phone: input.phone,
        use_case: input.useCase,
        website: input.website ?? '',
        source: 'desktop_personal',
      }),
    });
    const payload = await readJsonObject(response);
    if (response.status !== 202) {
      return {
        success: false,
        userMessage: 'No pudimos enviar tu solicitud. Intenta nuevamente.',
        technicalCode: `team_demo_request_failed_${response.status}`,
      };
    }
    return payload ? { ...payload, success: true } : { success: true };
  }
}
